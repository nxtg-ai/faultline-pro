/**
 * Faultline Plugin System — public API
 *
 * Import from this module to use the plugin system:
 *   import { FaultlinePlugin, PluginContext } from '@nxtg/faultline/plugins';
 */
export type {
  FaultlinePlugin,
  FaultlineProvider,
  ProviderFactory,
  PluginContext,
  Rule,
  Finding,
  RuleFactory,
  LoadedPlugin,
} from './types.js';

export {
  loadPlugin,
  loadPluginsFromConfig,
  getLoadedPlugins,
  isPluginLoaded,
  resetPluginRegistry,
} from './loader.js';
