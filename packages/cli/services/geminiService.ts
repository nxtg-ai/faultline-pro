
import { GoogleGenAI } from "@google/genai";
import type { Claim, VerificationResult } from '../types';
import { sanitizeVerifyError } from './verify-error';
import { recordUsage } from '../lib/usage-sink';
import { ExtractionError, parseExtractedClaims } from '../providers/extraction-error';
import { readVerdictReply, truncatedVerdict, unparseableVerdict } from '../providers/verdict-reply';
import { geminiCeilingConfig } from '../providers/call-ceilings';
import { isGeminiTruncated, OutputTruncatedError } from '../providers/output-truncation';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/** Resolved Gemini model ID, overridable via FAULTLINE_GEMINI_MODEL env var. */
export const GEMINI_MODEL: string =
  (typeof process !== 'undefined' ? process.env?.FAULTLINE_GEMINI_MODEL : undefined) || DEFAULT_GEMINI_MODEL;

/**
 * BLG-005 defect-1: emit real Gemini SDK usage to the active scan's usage sink.
 * The SDK response carries usageMetadata (prompt, candidates, tool-use prompt and thoughts counts);
 * the engine previously discarded it. No-op outside a captureUsage() scope.
 * `isGrounding` = true only when this call used the googleSearch tool (bills the
 * per-grounded-prompt surcharge); false for extraction and shared-source verify.
 */
function recordGeminiUsage(response: any, isGrounding: boolean, callType: string): void {
  const u = response?.usageMetadata ?? {};
  recordUsage({
    provider: 'gemini',
    model: GEMINI_MODEL,
    callType,
    // Google bills tool-use prompt tokens as input and thinking tokens as output; neither is in
    // promptTokenCount or candidatesTokenCount. One grounded call on 2026-10-21 reported 25/79 there
    // and 122 tool-use + 120 thinking tokens beside them (GoPMO 1.18.11.7.18).
    inputTokens: count(u.promptTokenCount) + count(u.toolUsePromptTokenCount),
    outputTokens: count(u.candidatesTokenCount) + count(u.thoughtsTokenCount),
    isGrounding,
  });
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

// Helper to sanitize JSON strings by finding the first { or [ and last } or ]
const cleanJson = (text: string): string => {
  if (!text) return '';

  // First try to extract from markdown code blocks
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (match && match[1]) {
    return match[1].trim();
  }

  // If no code blocks, look for the first '{' or '[' and the last '}' or ']'
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');

  let start = -1;
  let end = -1;

  // Determine if it's likely an object or array
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

  // Fallback: return trimmed text and hope for the best
  return text.replace(/```json\n?|```/g, '').trim();
};

const getClient = (apiKey: string) => {
  if (typeof GoogleGenAI === 'undefined') {
    throw new Error("GoogleGenAI SDK failed to load.");
  }
  return new GoogleGenAI({ apiKey });
};

export const extractClaims = async (text: string, apiKey: string, image?: { data: string, mimeType: string }): Promise<Claim[]> => {
  if ((!text && !image) || !apiKey) return [];

  const model = GEMINI_MODEL;

  const prompt = `
    Analyze the following ${image ? 'image and text' : 'text'} and decompose it into "structural elements" (atomic claims).
    Focus on extracting assertions that bear the weight of the argument.
    ${image ? 'If the image contains text or data, treat that as the primary source of structural elements.' : ''}

    CRITICAL RULE: Each sentence that contains an independently verifiable assertion must be extracted as its own separate claim. Do not merge claims from different sentences. If the text contains N distinct factual sentences, return at least N claims.

    ${text ? `Text: "${text}"` : ''}

    Return a JSON array where each object has:
    - id: a unique string ID (e.g., "c1")
    - text: the specific claim as a standalone sentence
    - type: one of "fact" (verifiable), "opinion" (subjective), "interpretation" (inference)
    - importance: integer 1-5 (5 being critical to the argument's integrity)
  `;

  const parts: any[] = [{ text: prompt }];
  if (image) {
    parts.unshift({ inlineData: { mimeType: image.mimeType, data: image.data } });
  }

  let response: any;
  try {
    const ai = getClient(apiKey);
    response = await ai.models.generateContent({
      model,
      contents: { parts },
      config: {
        ...geminiCeilingConfig('extract'),
        responseMimeType: "application/json",
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              id: { type: 'STRING' },
              text: { type: 'STRING' },
              type: { type: 'STRING' },
              importance: { type: 'INTEGER' },
            },
            required: ["id", "text", "type", "importance"]
          }
        }
      }
    });
  } catch (error) {
    throw ExtractionError.fromProviderError(error);
  }

  recordGeminiUsage(response, false, 'extraction');
  // Checked before the empty-reply test: a reply cut at its ceiling is a truncated
  // extraction, never fewer claims and never "unreadable" (GoPMO 1.18.11.7.18).
  if (isGeminiTruncated(response)) throw new ExtractionError('output_truncated', new OutputTruncatedError('gemini', 'extract'));
  // An empty reply (a blocked or cut-off response) is a failed extraction, not "no claims".
  if (!response.text?.trim()) throw new ExtractionError('invalid_output', new Error('empty extraction reply'));
  return parseExtractedClaims(cleanJson(response.text));
};

export const verifyClaim = async (claim: Claim, apiKey: string): Promise<VerificationResult> => {
  if (!apiKey) throw new Error("API Key required");

  const model = GEMINI_MODEL;

  const prompt = `
    You are a structural engineer for information integrity.
    Stress-test this claim using the provided Google Search tool.

    Claim: "${claim.text}"

    1. Search for evidence.
    2. Determine if the claim holds up ("supported"), fails ("contradicted"), or is inconclusive ("mixed").

    CALIBRATION RULE — apply before returning status:
    Use "mixed" when ANY of these conditions hold:
    - Different meta-analyses or major studies reach opposite conclusions
    - The effect is dose-dependent (harmful above a threshold, neutral or beneficial below it)
    - A major regulatory or scientific body (IARC, WHO, FDA, EFSA) classifies the agent as "possibly" or "probably" harmful (e.g. Group 2A/2B, Category 2) — not definitively
    - The claim is true in some populations, conditions, or dose ranges but not others
    - Scientific consensus is actively contested in peer-reviewed literature or has shifted in the last decade
    Use "contradicted" ONLY when the preponderance of robust, consistent evidence clearly refutes the claim with no meaningful body of contrary peer-reviewed evidence.
    When in doubt between "contradicted" and "mixed", always choose "mixed".

    OUTPUT INSTRUCTION:
    Return strictly a JSON object. Do not include markdown formatting or preamble.
    JSON Format:
    {
      "status": "supported" | "contradicted" | "mixed" | "unverified",
      "explanation": "Concise engineering assessment (max 2 sentences)."
    }
  `;

  try {
    const ai = getClient(apiKey);
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        ...geminiCeilingConfig('verify'),
        tools: [{ googleSearch: {} }],
        // responseMimeType cannot be used with googleSearch, so we rely on the prompt and cleanJson
      }
    });

    recordGeminiUsage(response, true, 'grounded-verify:gemini');
    // A reply cut at its ceiling is not a verdict, even if the part that arrived parses.
    if (isGeminiTruncated(response)) return truncatedVerdict(claim.id);
    // The grounded request searched and judged in one call, so retrieval and
    // verdict share this moment (Honor System #2, GoPMO 1.18.11.3 P1a).
    const returnedAt = new Date().toISOString();
    const servedModel = typeof (response as { modelVersion?: unknown }).modelVersion === 'string'
      && (response as { modelVersion: string }).modelVersion.length > 0
      ? (response as { modelVersion: string }).modelVersion
      : model;
    const verdict = readVerdictReply(cleanJson(response.text || ''));
    if (!verdict) {
      // Length only: the reply can quote the submitted claim, and stdout is kept
      // as operational logs on the hosted API (faultline-web privacy page, PR 61).
      console.warn(`Failed to parse JSON from verification response (${response.text?.length ?? 0} chars)`);
      // Not a verdict: no status, no sources, no provenance (al:5b18840b0116047a item c).
      return unparseableVerdict(claim.id);
    }

    const sources: Array<{ title: string; uri: string }> = [];

    // Extract sources from grounding chunks
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (chunks) {
      chunks.forEach((chunk: any) => {
        if (chunk.web) {
          sources.push({
            title: chunk.web.title || 'Source',
            uri: chunk.web.uri
          });
        }
      });
    }

    const uniqueSources = sources.filter((v, i, a) => a.findIndex(t => t.uri === v.uri) === i);

    // A grounded 'contradicted' needs a source that says the claim is false. With
    // no grounding source at all the model is reporting absence of evidence, which
    // is 'unverified', never a refutation (fw al:3dc2e0b227eaedd6, EP4 c4).
    const noSourceAbstain = verdict.status === 'contradicted' && uniqueSources.length === 0;
    const status = noSourceAbstain ? 'unverified' : verdict.status;

    return {
      claimId: claim.id,
      status,
      explanation: verdict.explanation,
      sources: uniqueSources.slice(0, 3),
      ...(noSourceAbstain ? { noSourceAbstain: true } : {}),
      ...searchSuggestionsOf(response.candidates?.[0]?.groundingMetadata),
      provenance: { provider: 'gemini', model: servedModel, verifiedAt: returnedAt, retriever: 'gemini-grounding', retrievedAt: returnedAt },
    };

  } catch (error) {
    console.error(`Error verifying claim ${claim.id}:`, error);
    return {
      claimId: claim.id,
      status: 'unverified',
      explanation: sanitizeVerifyError(error),
      sources: [],
      // The verification did NOT run (provider/API error — quota 429, model 503,
      // network). 'unverified' here means "never checked", not "checked, no
      // support found". apiError lets every consumer tell the two apart instead
      // of silently reporting a confident-but-false 'unverified' verdict.
      apiError: true,
    };
  }
};

/**
 * The Search Suggestions of one grounded response, unaltered, or {} when the
 * response carries none. Google's grounding terms require the suggestion chip
 * (`searchEntryPoint.renderedContent`, HTML and CSS) to be displayed as given
 * wherever the grounded result is shown, so nothing here trims or rewrites it.
 * fw renders it next to the verdict (fw al:da4e96a09515f831, GoPMO 1.18.11.3).
 */
export const searchSuggestionsOf = (
  metadata: unknown,
): { searchEntryPoint?: { renderedContent: string }; webSearchQueries?: string[] } => {
  if (!metadata || typeof metadata !== 'object') return {};
  const m = metadata as { searchEntryPoint?: { renderedContent?: unknown }; webSearchQueries?: unknown };
  const out: { searchEntryPoint?: { renderedContent: string }; webSearchQueries?: string[] } = {};
  const rendered = m.searchEntryPoint?.renderedContent;
  if (typeof rendered === 'string' && rendered.length > 0) out.searchEntryPoint = { renderedContent: rendered };
  if (Array.isArray(m.webSearchQueries)) {
    const queries = m.webSearchQueries.filter((q): q is string => typeof q === 'string');
    if (queries.length > 0) out.webSearchQueries = queries;
  }
  return out;
};

/**
 * Retrieve grounding sources for a claim using gemini's native googleSearch
 * tool — the same grounding mechanism `verifyClaim` uses, but exposed as a
 * pure retrieval primitive for the consensus engine's Retriever seam.
 *
 * Returns up to 3 de-duplicated sources. Returns [] on any API error (the
 * consensus engine treats an empty retrieval as "no shared evidence", and
 * every provider then judges from parametric knowledge against that empty set).
 */
export const retrieveSources = async (claimText: string, apiKey: string): Promise<Array<{ title: string; uri: string }>> => {
  if (!apiKey || !claimText) return [];

  const prompt = `Search the web for evidence relevant to this claim. Return a one-sentence summary of what you found.\n\nClaim: "${claimText}"`;

  try {
    const ai = getClient(apiKey);
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: { ...geminiCeilingConfig('retrieve'), tools: [{ googleSearch: {} }] },
    });

    recordGeminiUsage(response, true, 'grounded-retrieve:gemini');
    // A cut-off retrieval is a failed retrieval, handled like the API error below.
    if (isGeminiTruncated(response)) throw new OutputTruncatedError('gemini', 'retrieve');
    const sources: Array<{ title: string; uri: string }> = [];
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (chunks) {
      chunks.forEach((chunk: any) => {
        if (chunk.web) {
          sources.push({ title: chunk.web.title || 'Source', uri: chunk.web.uri });
        }
      });
    }
    const uniqueSources = sources.filter((v, i, a) => a.findIndex(t => t.uri === v.uri) === i);
    return uniqueSources.slice(0, 3);
  } catch (error) {
    console.error(`Error retrieving sources for claim:`, error);
    return [];
  }
};

/**
 * Verify a claim AGAINST a shared, pre-retrieved set of sources.
 * Unlike `verifyClaim` (which runs its own googleSearch), this judges using
 * ONLY the supplied sources, so it can participate in a consensus fan-out where
 * every provider reasons over identical evidence.
 */
export const verifyClaimGrounded = async (
  claim: Claim,
  sources: Array<{ title: string; uri: string }>,
  apiKey: string,
): Promise<VerificationResult> => {
  if (!apiKey) throw new Error('API Key required');

  const sourceBlock = sources.length > 0
    ? sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.uri}`).join('\n')
    : '(no sources retrieved)';

  const prompt = `
    You are a structural engineer for information integrity.
    Stress-test this claim using ONLY the retrieved sources below. Do not perform
    your own search; judge against the shared evidence set.

    Claim: "${claim.text}"

    Retrieved sources:
    ${sourceBlock}

    Determine if the claim holds up ("supported"), fails ("contradicted"), or is
    inconclusive ("mixed"). If the sources are empty or insufficient, judge from
    your own knowledge and lean "mixed" when uncertain.

    Return strictly a JSON object. No markdown, no preamble.
    { "status": "supported" | "contradicted" | "mixed" | "unverified", "explanation": "Concise assessment (max 2 sentences)." }
  `;

  try {
    const ai = getClient(apiKey);
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: geminiCeilingConfig('verifyGrounded'),
    });

    recordGeminiUsage(response, false, 'grounded-verify:gemini');
    // A cut-off vote is a failed vote with its own reason, not a verdict.
    if (isGeminiTruncated(response)) return { ...truncatedVerdict(claim.id), sources };
    const verdict = readVerdictReply(cleanJson(response.text || ''));
    // An unreadable reply is a failed vote, not a 'mixed' one (al:5b18840b0116047a item c).
    if (!verdict) return { ...unparseableVerdict(claim.id), sources };

    return {
      claimId: claim.id,
      status: verdict.status,
      explanation: verdict.explanation,
      sources,
    };
  } catch (error) {
    // Grounded verify never ran (quota 429 / model 503 / network). Sanitize —
    // never leak the raw provider payload into a customer report — and flag
    // apiError so consensus fusion + caches treat it as "not checked".
    console.error(`Error verifying claim ${claim.id} (grounded gemini):`, error);
    return {
      claimId: claim.id,
      status: 'unverified',
      explanation: sanitizeVerifyError(error),
      sources,
      apiError: true,
    };
  }
};

export const generateCritiqueAndPrompt = async (originalText: string, failedClaims: Claim[], apiKey: string): Promise<{ critique: string; improvedPrompt: string }> => {
  if (!apiKey) return { critique: "Auth Error", improvedPrompt: "Missing API Key" };

  const model = GEMINI_MODEL;

  const prompt = `
    I have performed a structural integrity test on a text and found these fractures (contradicted or mixed claims):
    ${failedClaims.map(c => `- ${c.text}`).join('\n')}

    Original Text context: "${originalText.substring(0, 500)}..."

    1. Write a brief "Structural Integrity Assessment" (max 50 words) describing how stable or dangerous this information is. Use seismic/engineering metaphors.
    2. Suggest a "Reinforcement Prompt" the user could use to rebuild this answer with a stronger foundation.

    Return JSON: { "critique": string, "improvedPrompt": string }
  `;

  try {
    const ai = getClient(apiKey);
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { ...geminiCeilingConfig('critique'), responseMimeType: "application/json" }
    });
    recordGeminiUsage(response, false, 'critique:gemini');
    // A cut-off critique takes the fallback below, like any failed critique.
    if (isGeminiTruncated(response)) throw new OutputTruncatedError('gemini', 'critique');
    const cleanedText = cleanJson(response.text || '{}');
    return JSON.parse(cleanedText);
  } catch (error) {
    return { critique: "Analysis incomplete.", improvedPrompt: "Verify facts before trusting AI outputs." };
  }
};
