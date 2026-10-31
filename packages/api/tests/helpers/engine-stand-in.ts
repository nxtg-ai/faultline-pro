/**
 * Test-only registry override for the claim meter tests.
 *
 * A claim is billable only when the engine bound a retriever to its verdict,
 * and the engine binds one only to the built-in instance of a provider id
 * ('gemini' gets 'gemini-grounding'). The built-in 'mock' provider can no
 * longer be replaced and has no engine retriever, so these tests mock the
 * registry: every provider the engine resolves is the test's fixture, and a
 * fixture resolved under a built-in id answers as that built-in's own instance.
 * No real provider is called.
 *
 * Use it inside a vi.mock factory:
 *   vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
 *     const { engineStandInRegistry } = await import('./helpers/engine-stand-in.js');
 *     return engineStandInRegistry(await importOriginal(), () => fixture);
 *   });
 */
type Registry = typeof import('@nxtg/faultline/providers/registry.js');

export function engineStandInRegistry(actual: Registry, fixture: (name?: string) => object): Registry {
  const standIns = new WeakMap<object, string>();
  return {
    ...actual,
    builtInProviderIdOf: (p: unknown) =>
      (p && typeof p === 'object' ? standIns.get(p) : undefined) ?? actual.builtInProviderIdOf(p),
    getProvider: ((_key: string, name?: string) => {
      // A fresh object per call, so the stand-in id recorded is the one this call asked for.
      const provider = { ...fixture(name) };
      if (name !== undefined && actual.isBuiltInProviderName(name)) standIns.set(provider, name);
      return provider;
    }) as Registry['getProvider'],
  };
}

/** The provider the claim meter tests scan with: the one provider id with an engine retriever. */
export const ENGINE_PROVIDER = 'gemini';

/** One source, so a verdict is billable once the engine binds its retriever. */
export const ONE_SOURCE = [{ title: 'Source', uri: 'https://example.org/source' }];

/** A placeholder provider key, built from parts, so key resolution for 'gemini' succeeds. */
export const placeholderProviderKey = (): string => ['fixture', 'provider', 'value'].join('-');
