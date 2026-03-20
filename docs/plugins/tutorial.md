# Create Your First Faultline Plugin

Faultline plugins extend the platform with custom **rules** and **providers**.
A rule detects a pattern in AI-generated text (e.g. unverified statistics, legal
disclaimers, profanity). A provider is a new LLM backend for claim verification
(e.g. a local model, a private API, a mock for CI).

This tutorial walks you through building, testing, publishing, and installing a
plugin — from empty directory to live in the marketplace in about 10 minutes.

---

## Prerequisites

- Node.js 18+ (ESM support required)
- A Faultline API key (for publishing)
- `@nxtg/faultline` installed in your project

---

## 1. Scaffold the package

```bash
mkdir faultline-plugin-no-hyperlinks
cd faultline-plugin-no-hyperlinks
npm init -y
```

Edit `package.json`:

```json
{
  "name": "faultline-plugin-no-hyperlinks",
  "version": "1.0.0",
  "description": "Flags raw hyperlinks in AI-generated content that aren't verified",
  "type": "module",
  "main": "index.js",
  "keywords": ["faultline", "faultline-plugin", "links", "verification"],
  "license": "MIT"
}
```

> **Convention**: name your plugin `faultline-plugin-<what-it-does>` so it
> appears in search results when users query `faultline-plugin`.

---

## 2. Write the rule

Create `index.js`:

```js
// index.js — Faultline plugin: flag unverified hyperlinks

const URL_RE = /https?:\/\/[^\s"'<>]+/g;

const noHyperlinksRule = {
  id: 'no-unverified-hyperlinks',
  name: 'No Unverified Hyperlinks',
  description: 'Flags raw http/https URLs that appear without a verification note.',
  check(content) {
    const findings = [];
    let match;
    while ((match = URL_RE.exec(content)) !== null) {
      // Only flag if the surrounding text doesn't mention "verified" or "source"
      const context = content.slice(Math.max(0, match.index - 40), match.index + 80);
      if (!/verified|source|citation|reference/i.test(context)) {
        findings.push({
          ruleId:   'no-unverified-hyperlinks',
          severity: 'medium',
          message:  `Unverified URL detected: ${match[0]}`,
          match:    match[0],
          offset:   match.index,
        });
      }
    }
    return findings;
  },
};

const plugin = {
  name: 'faultline-plugin-no-hyperlinks',
  version: '1.0.0',

  register(ctx) {
    ctx.registerRule('no-unverified-hyperlinks', () => noHyperlinksRule);
    ctx.log('no-unverified-hyperlinks rule registered');
  },
};

export default plugin;
```

### Rule contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | ✓ | Unique rule identifier (kebab-case) |
| `name` | `string` | ✓ | Human-readable name |
| `description` | `string` | ✓ | What the rule detects |
| `check(content)` | `(string) => Finding[]` | ✓ | Returns zero or more findings |

### Finding contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ruleId` | `string` | ✓ | Must match the rule's `id` |
| `severity` | `'low' \| 'medium' \| 'high' \| 'critical'` | ✓ | Impact level |
| `message` | `string` | ✓ | Human-readable description |
| `match` | `string` | — | The matched text fragment |
| `offset` | `number` | — | Character offset in `content` |

---

## 3. Add a provider (optional)

If your plugin provides a new LLM backend, add it alongside the rule:

```js
function createMyProvider(apiKey) {
  return {
    name: 'my-llm',

    async extractClaims(text) {
      // Call your LLM API here
      // Return: Array<{ id, text, type, importance }>
      const response = await fetch('https://my-llm-api.example.com/claims', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return response.json();
    },

    async verifyClaim(claim) {
      // Return: { claimId, status, explanation, sources }
      // status: 'supported' | 'contradicted' | 'unverified' | 'mixed'
      return {
        claimId:     claim.id,
        status:      'unverified',
        explanation: 'Verification not available for this provider',
        sources:     [],
      };
    },
  };
}

const plugin = {
  name: 'faultline-plugin-my-llm',
  version: '1.0.0',
  register(ctx) {
    ctx.registerProvider('my-llm', createMyProvider);
  },
};

export default plugin;
```

Use it via: `faultline scan --provider my-llm --text "..."`

---

## 4. Test locally

Load the plugin from a local path in your `.faultlinerc.json`:

```json
{
  "plugins": ["/absolute/path/to/faultline-plugin-no-hyperlinks"]
}
```

Or install it globally and reference by name:

```bash
npm install -g ./
```

Run the CLI to verify it loaded:

```bash
faultline plugin list
# → faultline-plugin-no-hyperlinks (v1.0.0)
```

Run a scan with your rule enabled:

```bash
faultline scan \
  --text "Check out https://example.com/study for more details." \
  --rules no-unverified-hyperlinks
```

Expected output: one finding with `severity: medium`.

### Unit test

```js
// test/rule.test.js
import plugin from '../index.js';
import assert from 'node:assert/strict';

const ctx = {
  registeredRules: {},
  registerRule(name, factory) { this.registeredRules[name] = factory(); },
  registerProvider() {},
  log() {},
};

await plugin.register(ctx);
const rule = ctx.registeredRules['no-unverified-hyperlinks'];

// Should find an unverified URL
const findings = rule.check('Visit https://example.com for details.');
assert.equal(findings.length, 1);
assert.equal(findings[0].severity, 'medium');

// Should NOT flag a verified URL
const clean = rule.check('Verified source: https://example.com (citation confirmed).');
assert.equal(clean.length, 0);

console.log('✓ All tests pass');
```

```bash
node test/rule.test.js
```

---

## 5. Publish to the Faultline Marketplace

Once your plugin is ready, publish it so others can discover and install it.

```bash
curl -X POST https://faultline-api.fly.dev/plugins/publish \
  -H "x-api-key: YOUR_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name":        "faultline-plugin-no-hyperlinks",
    "version":     "1.0.0",
    "description": "Flags raw hyperlinks in AI-generated content that are not verified",
    "type":        "rule",
    "keywords":    ["links", "verification", "quality"],
    "repoUrl":     "https://github.com/you/faultline-plugin-no-hyperlinks",
    "readme":      "# faultline-plugin-no-hyperlinks\n\nFlags unverified URLs..."
  }'
```

**Response (201 Created):**

```json
{
  "plugin": {
    "id": "a1b2c3d4-...",
    "name": "faultline-plugin-no-hyperlinks",
    "version": "1.0.0",
    "downloadCount": 0,
    "publishedAt": "2026-03-20T..."
  },
  "created": true,
  "message": "Plugin \"faultline-plugin-no-hyperlinks\" published successfully."
}
```

To update the listing after releasing `v1.1.0`, publish again with the new
version — the same API key is your identity. Ownership conflicts are rejected
with HTTP 409.

---

## 6. Install someone else's plugin

Search for plugins:

```bash
curl "https://faultline-api.fly.dev/plugins/search?q=statistics&type=rule"
```

Get install instructions:

```bash
curl -X POST https://faultline-api.fly.dev/plugins/install \
  -H "x-api-key: YOUR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"name": "faultline-plugin-statistics"}'
```

**Response:**

```json
{
  "plugin": { "name": "faultline-plugin-statistics", ... },
  "install": {
    "npm":    "npm install faultline-plugin-statistics",
    "yarn":   "yarn add faultline-plugin-statistics",
    "pnpm":   "pnpm add faultline-plugin-statistics",
    "config": "// .faultlinerc.json\n{\"plugins\": [\"faultline-plugin-statistics\"]}"
  }
}
```

Run the returned `npm install` command, add the plugin to `.faultlinerc.json`,
and it will be loaded automatically on the next `faultline scan`.

---

## Marketplace API reference

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /plugins/publish` | Required | Publish or update a plugin |
| `GET /plugins/search` | None | Search by name, description, keywords, type |
| `GET /plugins/:id` | None | Get a plugin by UUID |
| `POST /plugins/install` | Required | Get install instructions + record download |

### Publish payload

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | ✓ | Valid npm package name, lowercase |
| `version` | string | ✓ | Semver (e.g. `1.0.0`) |
| `description` | string | ✓ | 10–500 characters |
| `type` | string | ✓ | `"rule"`, `"provider"`, or `"both"` |
| `keywords` | string[] | — | Max 5 items |
| `repoUrl` | string | — | Valid `http://` or `https://` URL |
| `readme` | string | — | Markdown, max 10,000 characters |

### Search query parameters

| Parameter | Description |
|-----------|-------------|
| `q` | Text search (name, description, keywords) |
| `type` | `rule`, `provider`, or `both` |
| `sort` | `downloads` (default), `recent`, `name` |
| `limit` | Results per page (default: 20, max: 50) |
| `offset` | Pagination offset |

---

## Plugin naming conventions

| Pattern | Use for |
|---------|---------|
| `faultline-plugin-<rule-name>` | Rules that detect specific patterns |
| `faultline-plugin-<provider-name>` | New LLM providers |
| `faultline-plugin-<topic>` | Mixed rules + providers for a domain |
| `@your-org/faultline-plugin-<name>` | Scoped / enterprise plugins |

---

## Example plugins

| Plugin | Type | Description |
|--------|------|-------------|
| `faultline-plugin-no-todos` | rule | Flags unresolved TODO markers |
| `faultline-plugin-statistics` | rule | Detects unverified statistical claims |
| `faultline-plugin-echo` | provider | Offline provider for CI — no API key |

See `examples/custom-plugin/` in this repo for a working reference implementation.

---

*Questions?  Open an issue or post in the Faultline community forum.*
