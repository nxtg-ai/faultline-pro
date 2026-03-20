
import { GoogleGenAI } from "@google/genai";
import type { Claim, VerificationResult, ClaimStatus } from '../types';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/** Resolved Gemini model ID, overridable via FAULTLINE_GEMINI_MODEL env var. */
export const GEMINI_MODEL: string =
  (typeof process !== 'undefined' ? process.env?.FAULTLINE_GEMINI_MODEL : undefined) || DEFAULT_GEMINI_MODEL;

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

  try {
    const ai = getClient(apiKey);

    const parts: any[] = [{ text: prompt }];
    if (image) {
      parts.unshift({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }

    const response = await ai.models.generateContent({
      model,
      contents: { parts },
      config: {
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

    const cleanedText = cleanJson(response.text || '[]');
    const result = JSON.parse(cleanedText);
    return Array.isArray(result) ? result : [];
  } catch (error) {
    console.error("Error extracting claims:", error);
    return [];
  }
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
        tools: [{ googleSearch: {} }],
        // responseMimeType cannot be used with googleSearch, so we rely on the prompt and cleanJson
      }
    });

    let resultJson: any = {};
    try {
      const cleanedText = cleanJson(response.text || '{}');
      if (cleanedText && cleanedText !== '{}') {
          resultJson = JSON.parse(cleanedText);
      } else {
        throw new Error("Empty JSON");
      }
    } catch (e) {
      console.warn("Failed to parse JSON from verification response", response.text);
      // Fallback: If text exists but isn't JSON, assume it's the explanation
      if (response.text) {
          resultJson = { status: 'mixed', explanation: response.text.substring(0, 150) + '...' };
      }
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

    return {
      claimId: claim.id,
      status: (resultJson.status || 'unverified') as ClaimStatus,
      explanation: resultJson.explanation || 'No structural analysis provided.',
      sources: uniqueSources.slice(0, 3)
    };

  } catch (error) {
    console.error(`Error verifying claim ${claim.id}:`, error);
    return {
      claimId: claim.id,
      status: 'unverified',
      explanation: 'Stress-test failed due to technical error.',
      sources: []
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
      config: { responseMimeType: "application/json" }
    });
    const cleanedText = cleanJson(response.text || '{}');
    return JSON.parse(cleanedText);
  } catch (error) {
    return { critique: "Analysis incomplete.", improvedPrompt: "Verify facts before trusting AI outputs." };
  }
};
