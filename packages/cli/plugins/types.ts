/**
 * Faultline Plugin System — public types.
 *
 * A plugin is any npm package that exports a default FaultlinePlugin object.
 * The plugin's register() method receives a PluginContext and uses it to
 * add custom providers and/or rules to the running Faultline CLI.
 *
 * @example
 * // my-faultline-plugin/index.js
 * export default {
 *   name: 'my-plugin',
 *   version: '1.0.0',
 *   register(ctx) {
 *     ctx.registerRule('no-todos', () => ({
 *       id: 'no-todos',
 *       name: 'No TODOs',
 *       description: 'Flags unresolved TODO markers in content',
 *       check(content) { ... }
 *     }));
 *   }
 * };
 */

import type { LLMProvider, ProviderFactory } from '../providers/base_provider.js';
import type { Rule, Finding, RuleFactory } from '../rules/base_rule.js';

// ── Re-exports for plugin authors ────────────────────────────────────────────

export type { LLMProvider as FaultlineProvider, ProviderFactory };
export type { Rule, Finding, RuleFactory };

// ── Plugin context ────────────────────────────────────────────────────────────

/**
 * Injected into every plugin's register() call.
 * Use this to add custom providers and rules to the Faultline runtime.
 */
export interface PluginContext {
  /**
   * Register a custom LLM provider.
   *
   * @param name    Provider name used in --provider flags and .faultlinerc.json.
   *                Must be lowercase with no spaces (e.g. "my-llm").
   * @param factory Factory function that creates the provider given an API key.
   *
   * @example
   * ctx.registerProvider('my-llm', (apiKey) => new MyLLMProvider(apiKey));
   */
  registerProvider(name: string, factory: ProviderFactory): void;

  /**
   * Register a custom rule.
   *
   * @param name    Rule name used in --rules flags and .faultlinerc.json.
   *                Must be lowercase with no spaces (e.g. "no-todos").
   * @param factory Factory function that creates the rule (called once at registration).
   *
   * @example
   * ctx.registerRule('no-todos', () => ({
   *   id: 'no-todos',
   *   name: 'No TODOs',
   *   description: 'Flags unresolved TODO markers',
   *   check(content) {
   *     const findings = [];
   *     const re = /\bTODO:/gi;
   *     let match;
   *     while ((match = re.exec(content)) !== null) {
   *       findings.push({ ruleId: 'no-todos', severity: 'high', message: 'Unresolved TODO', match: match[0], offset: match.index });
   *     }
   *     return findings;
   *   }
   * }));
   */
  registerRule(name: string, factory: RuleFactory): void;

  /**
   * Emit a log message during plugin initialization.
   * Shown only when FAULTLINE_DEBUG=1 is set.
   */
  log(message: string): void;
}

// ── Plugin interface ──────────────────────────────────────────────────────────

/**
 * The interface every Faultline plugin must implement.
 *
 * Export this as the **default export** from your plugin's entry point.
 *
 * @example
 * // index.js (CommonJS or ESM)
 * export default {
 *   name: 'my-org-faultline-rules',
 *   version: '1.0.0',
 *   register(ctx) {
 *     ctx.registerRule('no-todos', () => todoRule);
 *   }
 * };
 */
export interface FaultlinePlugin {
  /** Unique plugin identifier. Used in plugin list output. */
  name: string;

  /** Plugin version string (optional, shown in plugin list). */
  version?: string;

  /**
   * Called once when the plugin is loaded.
   * Use the provided context to register providers and rules.
   * May be async (return a Promise).
   */
  register(context: PluginContext): void | Promise<void>;
}

// ── Loaded plugin record ──────────────────────────────────────────────────────

/** Metadata for a successfully loaded plugin, as returned by the loader. */
export interface LoadedPlugin {
  packageName: string;
  plugin: FaultlinePlugin;
  loadedAt: string;
}
