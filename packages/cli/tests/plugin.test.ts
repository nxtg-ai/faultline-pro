import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import {
  loadPlugin,
  loadPluginsFromConfig,
  getLoadedPlugins,
  isPluginLoaded,
  resetPluginRegistry,
} from '../plugins/loader.js';
import type { FaultlinePlugin } from '../plugins/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Absolute path to the real example plugin shipped with the repo.
// The loader accepts absolute paths (starting with '/') and converts them to file:// URLs.
const EXAMPLE_PLUGIN_PATH = resolve(
  __dirname,
  '../../../examples/custom-plugin/index.js',
);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Plugin Loader', () => {
  beforeEach(() => {
    resetPluginRegistry();
  });

  afterEach(() => {
    resetPluginRegistry();
  });

  // ── Registry state ──────────────────────────────────────────────────────────

  describe('registry state', () => {
    it('starts empty after reset', () => {
      expect(getLoadedPlugins()).toHaveLength(0);
    });

    it('isPluginLoaded returns false for unknown plugin', () => {
      expect(isPluginLoaded('no-such-plugin')).toBe(false);
    });

    it('getLoadedPlugins returns all loaded plugins', async () => {
      // We'll use the real example plugin for an end-to-end load
      const record = await loadPlugin(EXAMPLE_PLUGIN_PATH);
      const all = getLoadedPlugins();
      expect(all).toHaveLength(1);
      expect(all[0].packageName).toBe(EXAMPLE_PLUGIN_PATH);
      expect(all[0].plugin).toBe(record.plugin);
    });
  });

  // ── loadPlugin ──────────────────────────────────────────────────────────────

  describe('loadPlugin', () => {
    it('loads the example plugin and returns a LoadedPlugin record', async () => {
      const record = await loadPlugin(EXAMPLE_PLUGIN_PATH);

      expect(record.packageName).toBe(EXAMPLE_PLUGIN_PATH);
      expect(record.plugin.name).toBe('@example/faultline-custom-rules');
      expect(record.plugin.version).toBe('1.0.0');
      expect(typeof record.plugin.register).toBe('function');
      expect(record.loadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('is idempotent — loading twice returns same record without re-registering', async () => {
      const first = await loadPlugin(EXAMPLE_PLUGIN_PATH);
      const second = await loadPlugin(EXAMPLE_PLUGIN_PATH);

      expect(first).toBe(second); // same object reference
      expect(isPluginLoaded(EXAMPLE_PLUGIN_PATH)).toBe(true);
    });

    it('marks plugin as loaded after first call', async () => {
      expect(isPluginLoaded(EXAMPLE_PLUGIN_PATH)).toBe(false);
      await loadPlugin(EXAMPLE_PLUGIN_PATH);
      expect(isPluginLoaded(EXAMPLE_PLUGIN_PATH)).toBe(true);
    });

    it('throws a helpful error for a non-existent absolute path', async () => {
      await expect(loadPlugin('/nonexistent/path/plugin.js')).rejects.toThrow('Failed to import plugin');
    });

    it('throws for a completely invalid path', async () => {
      await expect(loadPlugin('/definitely-not-real/plugin.js')).rejects.toThrow();
    });
  });

  // ── loadPluginsFromConfig ───────────────────────────────────────────────────

  describe('loadPluginsFromConfig', () => {
    it('returns empty array for empty plugins list', async () => {
      const results = await loadPluginsFromConfig([]);
      expect(results).toHaveLength(0);
    });

    it('loads a valid plugin and reports ok: true', async () => {
      const results = await loadPluginsFromConfig([EXAMPLE_PLUGIN_PATH]);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe(EXAMPLE_PLUGIN_PATH);
      expect(results[0].ok).toBe(true);
      expect(results[0].error).toBeUndefined();
    });

    it('reports ok: false for a failing plugin without crashing', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const results = await loadPluginsFromConfig(['/nonexistent/bad-plugin.js']);

      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].error).toBeTruthy();
      expect(stderrSpy).toHaveBeenCalled();

      stderrSpy.mockRestore();
    });

    it('continues loading remaining plugins after one failure', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const results = await loadPluginsFromConfig(['/nonexistent/bad-plugin.js', EXAMPLE_PLUGIN_PATH]);

      expect(results).toHaveLength(2);
      expect(results[0].ok).toBe(false);
      expect(results[1].ok).toBe(true);
      expect(results[1].name).toBe(EXAMPLE_PLUGIN_PATH);

      stderrSpy.mockRestore();
    });

    it('is idempotent — loading same plugin twice skips second load', async () => {
      await loadPluginsFromConfig([EXAMPLE_PLUGIN_PATH]);
      const results = await loadPluginsFromConfig([EXAMPLE_PLUGIN_PATH]);

      // Second call succeeds (idempotent, no error)
      expect(results[0].ok).toBe(true);
      // Registry still has only one entry
      expect(getLoadedPlugins()).toHaveLength(1);
    });
  });

  // ── PluginContext — registration side-effects ───────────────────────────────

  describe('PluginContext registration', () => {
    it('example plugin registers the no-unverified-statistics rule', async () => {
      const { listRules } = await import('../rules/registry.js');
      const beforeLoad = listRules();

      await loadPlugin(EXAMPLE_PLUGIN_PATH);

      const afterLoad = listRules();
      expect(afterLoad).toContain('no-unverified-statistics');
    });

    it('example plugin registers the echo provider', async () => {
      const { listProviders } = await import('../providers/registry.js');
      await loadPlugin(EXAMPLE_PLUGIN_PATH);

      const providers = listProviders();
      expect(providers).toContain('echo');
    });

    it('registered rule produces findings for statistical claims without citations', async () => {
      const { getRule } = await import('../rules/registry.js');
      await loadPlugin(EXAMPLE_PLUGIN_PATH);

      const rule = getRule('no-unverified-statistics');
      expect(rule).toBeDefined();

      const findings = rule.check('Studies show 80% of users prefer our product.');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].ruleId).toBe('no-unverified-statistics');
      expect(findings[0].severity).toBe('medium');
    });

    it('registered rule does not flag statistics that have inline citations', async () => {
      const { getRule } = await import('../rules/registry.js');
      await loadPlugin(EXAMPLE_PLUGIN_PATH);

      const rule = getRule('no-unverified-statistics');
      const findings = rule.check(
        'Studies show 80% improvement (Source: Smith et al., 2024 — https://example.com/study).',
      );
      expect(findings).toHaveLength(0);
    });

    it('registered rule returns empty findings for plain text with no statistics', async () => {
      const { getRule } = await import('../rules/registry.js');
      await loadPlugin(EXAMPLE_PLUGIN_PATH);

      const rule = getRule('no-unverified-statistics');
      const findings = rule.check('The sky is blue and water is wet.');
      expect(findings).toHaveLength(0);
    });
  });

  // ── LoadedPlugin record shape ───────────────────────────────────────────────

  describe('LoadedPlugin record', () => {
    it('record has correct shape', async () => {
      const record = await loadPlugin(EXAMPLE_PLUGIN_PATH);

      expect(record).toMatchObject({
        packageName: expect.any(String),
        plugin: expect.objectContaining({
          name: expect.any(String),
          register: expect.any(Function),
        }),
        loadedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    });

    it('loadedAt is a valid ISO 8601 date', async () => {
      const record = await loadPlugin(EXAMPLE_PLUGIN_PATH);
      const date = new Date(record.loadedAt);
      expect(date.getTime()).not.toBeNaN();
    });
  });
});
