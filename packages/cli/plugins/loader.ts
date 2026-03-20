/**
 * Faultline Plugin Loader
 *
 * Loads plugins from npm packages or local paths by:
 * 1. Resolving the module relative to the user's project (cwd)
 * 2. Dynamic import() of the resolved path
 * 3. Extracting the default export as a FaultlinePlugin
 * 4. Calling plugin.register(context) with an injected PluginContext
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { registerProvider } from '../providers/registry.js';
import { registerRule } from '../rules/registry.js';
import type { FaultlinePlugin, PluginContext, LoadedPlugin } from './types.js';

// ── In-memory plugin registry (deduplicated by package name) ─────────────────

const _loaded: Map<string, LoadedPlugin> = new Map();

/** Returns all currently loaded plugins. */
export function getLoadedPlugins(): LoadedPlugin[] {
  return Array.from(_loaded.values());
}

/** Returns true if a plugin with this package name has already been loaded. */
export function isPluginLoaded(packageName: string): boolean {
  return _loaded.has(packageName);
}

/** Clears the in-memory plugin registry. Used in tests. */
export function resetPluginRegistry(): void {
  _loaded.clear();
}

// ── PluginContext factory ─────────────────────────────────────────────────────

function createContext(pluginName: string): PluginContext {
  return {
    registerProvider(name, factory) {
      registerProvider(name, factory);
      debug(`[plugin:${pluginName}] registered provider "${name}"`);
    },
    registerRule(name, factory) {
      registerRule(name, factory);
      debug(`[plugin:${pluginName}] registered rule "${name}"`);
    },
    log(message) {
      debug(`[plugin:${pluginName}] ${message}`);
    },
  };
}

function debug(msg: string): void {
  if (process.env.FAULTLINE_DEBUG) process.stderr.write(msg + '\n');
}

// ── Module resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a plugin package name or relative path to an absolute file URL,
 * relative to `projectDir` (defaults to process.cwd()).
 *
 * Handles:
 * - npm package names: "@org/pkg" or "pkg"
 * - Relative paths: "./local-plugin.js" or "../plugins/my-plugin/index.js"
 * - Absolute paths: "/abs/path/to/plugin.js"
 */
function resolvePluginPath(packageNameOrPath: string, projectDir: string): string {
  const isRelativeOrAbsolute =
    packageNameOrPath.startsWith('./') ||
    packageNameOrPath.startsWith('../') ||
    packageNameOrPath.startsWith('/');

  if (isRelativeOrAbsolute) {
    // Resolve relative to projectDir
    const abs = resolve(projectDir, packageNameOrPath);
    return pathToFileURL(abs).href;
  }

  // npm package — resolve from projectDir node_modules
  const syntheticRequire = createRequire(resolve(projectDir, '_synthetic_.js'));
  try {
    const resolvedPath = syntheticRequire.resolve(packageNameOrPath);
    return pathToFileURL(resolvedPath).href;
  } catch {
    throw new Error(
      `Cannot find plugin "${packageNameOrPath}".\n` +
      `  Run: npm install ${packageNameOrPath}\n` +
      `  Then retry.`,
    );
  }
}

// ── Core loader ───────────────────────────────────────────────────────────────

/**
 * Load and register a single plugin.
 *
 * @param packageNameOrPath  npm package name (e.g. "@my/faultline-rules") or
 *                           relative path (e.g. "./my-plugin.js")
 * @param projectDir         Root directory from which to resolve the package.
 *                           Defaults to process.cwd().
 * @returns The LoadedPlugin record on success.
 * @throws  Error with a helpful message if loading or registration fails.
 */
export async function loadPlugin(
  packageNameOrPath: string,
  projectDir = process.cwd(),
): Promise<LoadedPlugin> {
  if (_loaded.has(packageNameOrPath)) {
    return _loaded.get(packageNameOrPath)!;
  }

  const fileUrl = resolvePluginPath(packageNameOrPath, projectDir);

  let mod: Record<string, unknown>;
  try {
    mod = await import(fileUrl) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to import plugin "${packageNameOrPath}": ${(err as Error).message}`,
    );
  }

  // Support both `export default plugin` and `module.exports = plugin` (CJS interop)
  const plugin = (mod.default ?? mod) as Partial<FaultlinePlugin>;

  if (!plugin || typeof plugin.register !== 'function') {
    throw new Error(
      `Plugin "${packageNameOrPath}" does not export a valid FaultlinePlugin object.\n` +
      `  Expected: default export with a register(ctx) method.\n` +
      `  Got: ${JSON.stringify(Object.keys(plugin ?? {}))}`
    );
  }

  if (typeof plugin.name !== 'string' || !plugin.name) {
    throw new Error(
      `Plugin "${packageNameOrPath}" is missing a required "name" field.`,
    );
  }

  const context = createContext(plugin.name);

  try {
    await plugin.register(context);
  } catch (err) {
    throw new Error(
      `Plugin "${packageNameOrPath}" threw an error during register(): ${(err as Error).message}`,
    );
  }

  const record: LoadedPlugin = {
    packageName: packageNameOrPath,
    plugin: plugin as FaultlinePlugin,
    loadedAt: new Date().toISOString(),
  };

  _loaded.set(packageNameOrPath, record);
  debug(`[faultline] loaded plugin "${plugin.name}" from "${packageNameOrPath}"`);

  return record;
}

/**
 * Load all plugins listed in the config's `plugins` array.
 * Already-loaded plugins are skipped (idempotent).
 *
 * @param plugins    Array of package names or relative paths.
 * @param projectDir Root directory for resolution (defaults to cwd).
 * @returns          Array of results: { name, ok, error? }
 */
export async function loadPluginsFromConfig(
  plugins: string[],
  projectDir = process.cwd(),
): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
  if (!plugins || plugins.length === 0) return [];

  const results: Array<{ name: string; ok: boolean; error?: string }> = [];

  for (const packageName of plugins) {
    try {
      await loadPlugin(packageName, projectDir);
      results.push({ name: packageName, ok: true });
    } catch (err) {
      const error = (err as Error).message;
      results.push({ name: packageName, ok: false, error });
      // Log to stderr but don't crash the CLI — a broken plugin shouldn't
      // prevent the user from scanning.
      process.stderr.write(`[faultline] Warning: plugin "${packageName}" failed to load: ${error}\n`);
    }
  }

  return results;
}
