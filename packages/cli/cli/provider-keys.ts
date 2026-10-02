/**
 * provider-keys.ts — how the scan engine picks its default provider and finds a
 * provider's API key. Shared by `scan()` and the API's admin verify route, so a
 * verify-only call resolves the provider exactly as a non-consensus scan does.
 */

/** The provider a scan uses when the caller names none (prod: gemini, consensus off). */
export const DEFAULT_SCAN_PROVIDER = 'gemini';

const PROVIDER_KEY_ENV: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
};

/**
 * Resolve the API key for a given provider name.
 * Returns '' for 'mock' (no key required).
 * Throws if the required env var is missing.
 */
export function resolveApiKey(name: string): string {
  if (name === 'mock') return '';
  const envVar = PROVIDER_KEY_ENV[name] || 'GEMINI_API_KEY';
  const key = process.env[envVar] || '';
  if (!key) {
    const hint = name === 'gemini'
      ? `Get a free key at https://aistudio.google.com/apikey → export GEMINI_API_KEY=your-key`
      : `Set ${envVar} in your environment`;
    throw new Error(`No API key found for "${name}". ${hint}`);
  }
  return key;
}
