# @nxtg/faultline-sdk

TypeScript SDK for the [Faultline Pro](https://github.com/nxtg/faultline-pro) API — AI claim forensics and EU AI Act compliance reporting.

## Install

```bash
npm install @nxtg/faultline-sdk
```

## Quick start

```ts
import { FaultlineClient } from '@nxtg/faultline-sdk';

const client = new FaultlineClient({
  apiKey: process.env.FAULTLINE_API_KEY!,
  // baseUrl defaults to 'http://localhost:3000'
});

// Scan text for claim forensics
const result = await client.scan(
  'GPT-4 was released in March 2023 and scored in the 90th percentile on the bar exam.',
);
console.log(result.overallRisk);        // 'low' | 'medium' | 'high' | 'critical'
console.log(result.claims.length);      // number of extracted claims
console.log(result.complianceReport);   // EU AI Act compliance detail

// Create an API key (admin only)
const key = await client.createKey('CI pipeline', ['scan', 'report']);
console.log(key.key); // raw key value — store it now, cannot be retrieved again
```

## All methods

### Scan

```ts
// Scan a single text
const result: ScanResult = await client.scan(text, provider?);

// Scan multiple texts concurrently (1–10)
const batch: BatchScanResponse = await client.scanBatch(texts, provider?);

// Generate a PDF compliance report (returns ArrayBuffer)
const pdf: ArrayBuffer = await client.scanReport(text, provider?, projectName?);
```

### Keys (admin only)

```ts
// Create a key — key.key is the raw value, shown only once
const key: ApiKey = await client.createKey(name, permissions?);

// List all keys (raw key value omitted)
const keys: ApiKey[] = await client.listKeys();

// Delete a key permanently
await client.deleteKey(id);
```

### Usage

```ts
// Get per-day scan counts for the authenticated key
const usage: UsageResponse = await client.getUsage();
// usage.usage is a Record<string, number> keyed by YYYY-MM-DD
```

### Dashboard (admin only)

```ts
const dashboard: DashboardResponse = await client.getDashboard();
dashboard.scans.today;              // total scans today
dashboard.riskDistribution.high;    // count of high-risk scans
dashboard.keyUsage;                 // per-key counts for today
```

### Webhooks (admin only)

```ts
// Register a webhook — result.secret is shown only once
const webhook: Webhook = await client.createWebhook(url, events, secret?);

// List webhooks (secret omitted)
const webhooks: WebhookPublic[] = await client.listWebhooks();

// Delete a webhook
await client.deleteWebhook(id);
```

## Error handling

All methods throw `FaultlineError` on non-2xx responses.

```ts
import { FaultlineClient, FaultlineError } from '@nxtg/faultline-sdk';

try {
  await client.scan('some text');
} catch (err) {
  if (err instanceof FaultlineError) {
    console.error(`API error ${err.status}:`, err.message);
    // err.body contains the raw response body
  }
}
```

## Environment variable pattern

```ts
const client = new FaultlineClient({
  apiKey: process.env.FAULTLINE_API_KEY!,
  baseUrl: process.env.FAULTLINE_BASE_URL, // optional
});
```
