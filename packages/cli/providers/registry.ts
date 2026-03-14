import type { LLMProvider, ProviderFactory } from './base_provider';
import { createGeminiProvider } from './gemini_provider';
import { createClaudeProvider } from './claude_provider';
import { createOpenAIProvider } from './openai_provider';
import { createPerplexityProvider } from './perplexity_provider';
import { createMockProvider } from './mock_provider';

const DEFAULT_PROVIDER = 'gemini';

const factories: Record<string, ProviderFactory> = {
  gemini: createGeminiProvider,
  claude: createClaudeProvider,
  openai: createOpenAIProvider,
  perplexity: createPerplexityProvider,
  mock: createMockProvider,
};

/**
 * Get a provider instance by name.
 * Falls back to the FAULTLINE_PROVIDER environment variable, then to 'gemini'.
 *
 * @throws Error if the requested provider is not registered
 */
export function getProvider(apiKey: string, name?: string): LLMProvider {
  const providerName = name
    ?? (typeof process !== 'undefined' ? process.env?.FAULTLINE_PROVIDER : undefined)
    ?? DEFAULT_PROVIDER;

  const factory = factories[providerName];
  if (!factory) {
    const available = Object.keys(factories).join(', ');
    throw new Error(`Unknown provider "${providerName}". Available: ${available}`);
  }

  return factory(apiKey);
}

/**
 * Register a custom provider factory at runtime.
 */
export function registerProvider(name: string, factory: ProviderFactory): void {
  factories[name] = factory;
}

/**
 * List all registered provider names.
 */
export function listProviders(): string[] {
  return Object.keys(factories);
}
