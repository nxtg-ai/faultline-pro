import type { LLMProvider, ProviderFactory } from './base_provider';
import { createGeminiProvider } from './gemini_provider';
import { createClaudeProvider } from './claude_provider';
import { createOpenAIProvider } from './openai_provider';
import { createPerplexityProvider } from './perplexity_provider';
import { createMockProvider } from './mock_provider';

const DEFAULT_PROVIDER = 'gemini';

/**
 * The providers that ship with Faultline, by id. Module-private, so no caller
 * can change it, and registerProvider refuses each of its ids.
 */
const BUILT_IN_FACTORIES: ReadonlyMap<string, ProviderFactory> = new Map<string, ProviderFactory>([
  ['gemini', createGeminiProvider],
  ['claude', createClaudeProvider],
  ['openai', createOpenAIProvider],
  ['perplexity', createPerplexityProvider],
  ['mock', createMockProvider],
]);

// A Map, not an object literal: on a plain object `constructor`, `toString`
// and `__proto__` resolve through the prototype and pass a truthiness check,
// and registerProvider('__proto__', f) would rewrite the prototype
// (CodeQL js/unvalidated-dynamic-method-call).
const factories = new Map<string, ProviderFactory>(BUILT_IN_FACTORIES);

/**
 * Each instance a built-in factory made, with the built-in id it was made for.
 * The engine grants a built-in's retrieval only to an instance found here, so
 * a provider that merely answers to a built-in id gets nothing.
 */
const builtInInstances = new WeakMap<object, string>();

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

  const factory = factories.get(providerName);
  if (!factory) {
    const available = listProviders().join(', ');
    throw new Error(`Unknown provider "${providerName}". Available: ${available}`);
  }

  const provider = factory(apiKey);
  if (BUILT_IN_FACTORIES.get(providerName) === factory && provider && typeof provider === 'object') {
    builtInInstances.set(provider, providerName);
  }
  return provider;
}

/** True when `name`, trimmed and in any case, is the id of a built-in provider. */
export function isBuiltInProviderName(name: string): boolean {
  return typeof name === 'string' && BUILT_IN_FACTORIES.has(name.trim().toLowerCase());
}

/**
 * The built-in provider id whose own factory made `provider`, or undefined for
 * any other object (a plugin's provider, a test fixture, a wrapper).
 */
export function builtInProviderIdOf(provider: unknown): string | undefined {
  return provider && typeof provider === 'object' ? builtInInstances.get(provider) : undefined;
}

/**
 * Register a custom provider factory at runtime.
 *
 * @throws Error if `name` is a built-in provider id (compared trimmed and in
 *   any case): a built-in provider cannot be replaced.
 */
export function registerProvider(name: string, factory: ProviderFactory): void {
  if (isBuiltInProviderName(name)) {
    throw new Error(
      `Provider "${name}" is a built-in provider and cannot be replaced. ` +
      `Register a custom provider under its own name. Built-in: ${[...BUILT_IN_FACTORIES.keys()].join(', ')}`,
    );
  }
  factories.set(name, factory);
}

/**
 * List all registered provider names.
 */
export function listProviders(): string[] {
  return [...factories.keys()];
}
