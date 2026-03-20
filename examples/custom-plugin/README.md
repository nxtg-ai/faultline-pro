# @example/faultline-custom-rules

Example Faultline plugin demonstrating how to build custom rules and providers as npm packages.

## What this plugin provides

| Name | Type | Description |
|------|------|-------------|
| `no-unverified-statistics` | Rule | Flags percentage figures and statistical claims that lack a source citation |
| `echo` | Provider | Offline/testing provider — extracts one claim and always returns `unverified` |

## Install

```bash
# From local path (development)
faultline plugin install ./examples/custom-plugin

# From npm (once published)
faultline plugin install @example/faultline-custom-rules
```

This adds the plugin to your `.faultlinerc.json` automatically:

```json
{
  "plugins": ["@example/faultline-custom-rules"]
}
```

## Usage

```bash
# Use the custom rule
faultline scan --rules no-unverified-statistics "Studies show 80% improvement."

# Use the echo provider (no API key required)
faultline scan --provider echo "Any text you want to test."

# Both together
faultline scan --provider echo --rules no-unverified-statistics "Studies show 80% improvement."
```

## Writing your own plugin

A Faultline plugin is any ESM (or CJS) module that exports a default object with `name`, `version`, and `register(ctx)`.

### Minimal example

```js
// my-faultline-plugin/index.js
export default {
  name: 'my-plugin',
  version: '1.0.0',

  register(ctx) {
    // Add a custom rule
    ctx.registerRule('my-rule', () => ({
      id: 'my-rule',
      name: 'My Rule',
      description: 'Detects something specific',
      check(content) {
        const findings = [];
        if (content.includes('forbidden phrase')) {
          findings.push({
            ruleId: 'my-rule',
            severity: 'high',
            message: 'Found forbidden phrase',
            match: 'forbidden phrase',
            offset: content.indexOf('forbidden phrase'),
          });
        }
        return findings;
      },
    }));

    // Add a custom LLM provider
    ctx.registerProvider('my-llm', (apiKey) => ({
      name: 'My LLM',
      modelId: 'my-model-v1',
      async extractClaims(text) { /* ... */ },
      async verifyClaim(claim) { /* ... */ },
      async generateCritiqueAndPrompt(text, failed) { /* ... */ },
    }));
  },
};
```

### `PluginContext` API

| Method | Signature | Description |
|--------|-----------|-------------|
| `registerRule` | `(name, factory) => void` | Register a rule by name. Factory called once at registration. |
| `registerProvider` | `(name, factory) => void` | Register an LLM provider. Factory receives `apiKey` at scan time. |
| `log` | `(message) => void` | Emit debug messages (shown when `FAULTLINE_DEBUG=1`). |

### Plugin `package.json` requirements

```json
{
  "name": "my-faultline-plugin",
  "main": "index.js",
  "type": "module"
}
```

For CJS plugins, omit `"type": "module"` and use `module.exports = plugin`.
