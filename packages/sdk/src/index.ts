// ── Faultline SDK — hand-crafted TypeScript client ───────────────────────────
// Derived from packages/api/docs/openapi.yaml (Faultline API v0.2.0)

// ── Primitive enums ───────────────────────────────────────────────────────────

/** LLM provider used for claim extraction and verification. */
export type Permission = 'scan' | 'report' | 'upload' | 'admin' | 'pro';

/** LLM provider used for claim extraction and verification. */
export type Provider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

/** Overall risk assessment for the scanned text. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Extracted claim type. */
export type ClaimType = 'fact' | 'opinion' | 'interpretation';

/** Verification verdict for a single claim. */
export type ClaimStatus =
  | 'supported'
  | 'contradicted'
  | 'mixed'
  | 'unverified'
  | 'loading'
  | 'skipped';

/** EU AI Act risk tier (Regulation (EU) 2024/1689). */
export type EURiskLevel = 'unacceptable' | 'high' | 'limited' | 'minimal';

/** Severity level for a rule engine finding. */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Qualitative confidence in an EU risk classification. */
export type ConfidenceQualitative = 'high' | 'medium' | 'low';

/** Webhook event types. */
export type WebhookEvent = 'scan.complete' | 'scan.failed';

// ── Domain objects ────────────────────────────────────────────────────────────

/** An atomic claim extracted from the input text. */
export interface Claim {
  /** UUID of the claim. */
  id: string;
  /** The extracted claim text. */
  text: string;
  /** Claim type: fact, opinion, or interpretation. */
  type: ClaimType;
  /** Importance score (1 = low, 5 = critical). */
  importance: number;
}

/** A source reference returned by the verification engine. */
export interface Source {
  /** Title of the source document or web page. */
  title: string;
  /** URI of the source. */
  uri: string;
}

/** Verification result for a single claim. */
export interface VerificationResult {
  /** UUID of the claim this result belongs to. */
  claimId: string;
  /** Verification verdict. */
  status: ClaimStatus;
  /** Human-readable explanation of the verdict. */
  explanation: string;
  /** Supporting or contradicting source references. */
  sources: Source[];
}

/** A rule engine finding (PII, bias, toxicity, etc.). */
export interface Finding {
  /** Rule identifier that triggered this finding (e.g. `pii-email`). */
  ruleId: string;
  /** Severity of the finding. */
  severity: FindingSeverity;
  /** Human-readable description of the detected issue. */
  message: string;
  /** The matched text that triggered the finding. */
  match: string;
  /** Character offset in the original text where the match starts. */
  offset: number;
}

/** EU AI Act risk category detail. */
export interface EURiskCategory {
  level: EURiskLevel;
  title: string;
  description: string;
  articles: string[];
  requiredActions: string[];
}

/** Per-claim EU AI Act risk mapping. */
export interface ClaimRiskMapping {
  claimId: string;
  claimText: string;
  verificationStatus: ClaimStatus;
  riskLevel: EURiskLevel;
  category: EURiskCategory;
  /** EU AI Act article or annex references that matched this claim. */
  matchedPatterns: string[];
  confidence: ConfidenceQualitative;
  /** Numeric confidence score (0.0–1.0). */
  confidenceScore: number;
}

/** Summary counts of EU AI Act risk tiers across all claims. */
export interface EURiskSummary {
  unacceptable: number;
  high: number;
  limited: number;
  minimal: number;
  totalClaims: number;
  highestTier: EURiskLevel;
}

/** Distribution of claims by confidence score band. */
export interface ConfidenceDistribution {
  /** Claims with confidence >= 0.8. */
  high: number;
  /** Claims with confidence 0.5–0.8. */
  medium: number;
  /** Claims with confidence < 0.5. */
  low: number;
}

/** A triggered EU AI Act article reference. */
export interface TriggeredArticle {
  article: string;
  reason: string;
  claimIds: string[];
}

/** Full EU AI Act compliance report included in every scan result. */
export interface ComplianceReport {
  generatedAt: string;
  overallRiskLevel: RiskLevel;
  euRiskSummary: EURiskSummary;
  claimMappings: ClaimRiskMapping[];
  triggeredArticles: TriggeredArticle[];
  mitigations: string[];
  confidenceDistribution: ConfidenceDistribution;
}

/**
 * The structured output of a successful scan.
 *
 * `verifications` is a map from claim UUID to VerificationResult. Only
 * `fact` claims with importance >= 3 are verified (up to 8 per scan).
 */
export interface ScanResult {
  /** First 200 characters of the scanned text (truncated for storage). */
  input: string;
  /** Display name of the LLM provider used. */
  provider: string;
  /** All claims extracted from the input text. */
  claims: Claim[];
  /** Map of claim ID to verification result. */
  verifications: Record<string, VerificationResult>;
  /** Overall risk level for the scanned text. */
  overallRisk: RiskLevel;
  /** EU AI Act compliance report. */
  complianceReport: ComplianceReport;
  /** Rule engine findings (PII, bias, toxicity, security patterns). */
  ruleFindings: Finding[];
}

// ── API key types ─────────────────────────────────────────────────────────────

/** An API key record (without the raw key value). */
export interface ApiKey {
  id: string;
  name: string;
  permissions: Permission[];
  createdAt: string;
  /** Raw key value — only present on creation (POST /keys). */
  key?: string;
}

// ── Batch scan types ──────────────────────────────────────────────────────────

/** Request body for POST /scan/batch. */
export interface BatchScanRequest {
  /** Array of 1–10 texts to scan concurrently. */
  texts: string[];
  provider?: Provider;
}

/** Per-item error detail for a failed batch scan item. */
export interface BatchScanError {
  /** Zero-based index into the texts array. */
  index: number;
  error: string;
}

/**
 * Response from POST /scan/batch.
 *
 * `results` is in input order; positions that failed contain `null`.
 * Use `errors` for per-item error detail.
 */
export interface BatchScanResponse {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<ScanResult | null>;
  errors: BatchScanError[];
}

// ── Webhook types ─────────────────────────────────────────────────────────────

/** Request body for POST /webhooks. */
export interface CreateWebhookRequest {
  url: string;
  events: WebhookEvent[];
  /** Optional HMAC signing secret. Generated if omitted. */
  secret?: string;
}

/**
 * Webhook as returned by POST /webhooks (includes the signing secret).
 * Store `secret` securely — it cannot be retrieved again.
 */
export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  createdAt: string;
  /** HMAC-SHA256 signing secret. Only present on creation. */
  secret: string;
}

/** Webhook record as returned by GET /webhooks (signing secret omitted). */
export interface WebhookPublic {
  id: string;
  url: string;
  events: WebhookEvent[];
  createdAt: string;
}

// ── Compliance gate types ────────────────────────────────────────────────────

/** Per-article pass/fail result from the compliance gate. */
export interface CiGateArticleResult {
  article: string;
  status: string;
  pass: boolean;
}

/** Result of evaluating the EU AI Act compliance gate. */
export interface CiGateResult {
  pass: boolean;
  overallRisk: string;
  articles: CiGateArticleResult[];
  nonCompliantCount: number;
  totalArticles: number;
  exitCode: number;
  complianceScore?: number;
}

/** Response from POST /scan/compliance-gate or GET /scan/:id/compliance. */
export interface ComplianceGateResponse {
  gate: CiGateResult;
  report: Record<string, unknown>;
  scanId: string;
}

/** Result from POST /scan/compliance-diff. */
export interface ComplianceDiffResult {
  articles: Array<Record<string, unknown>>;
  summary: Record<string, number>;
  riskTrend: string;
}

/** A regulatory deadline from GET /compliance/deadlines. */
export interface ComplianceDeadline {
  id: string;
  name: string;
  regulation: string;
  description: string;
  deadline: string;
  daysUntil: number;
  severity: string;
  url: string;
}

/** Result from POST /scan/diff. */
export interface ScanDiffResult {
  before: ScanResult;
  after: ScanResult;
  newClaims: Claim[];
  removedClaims: Claim[];
  changedVerdicts: Array<{ claim: Claim; before: string; after: string }>;
  trustScoreDelta: number;
  summary: string;
  inlineDiff: Array<{ type: string; claim: string; before?: string; after?: string }>;
}

/** Result from DELETE /tenants/:id/data. */
export interface GdprErasureResult {
  tenantId: string;
  deleted: Record<string, number>;
}

// ── Usage / Dashboard types ───────────────────────────────────────────────────

/**
 * Usage data for the authenticated key.
 *
 * `usage` maps ISO date strings (YYYY-MM-DD) to scan counts for that day.
 */
export interface UsageResponse {
  keyId: string;
  usage: Record<string, number>;
}

/** Aggregate scan counts for today / 7-day / 30-day windows. */
export interface ScanCounts {
  today: number;
  week: number;
  month: number;
}

/** Risk distribution across all historical scans. */
export interface RiskDistribution {
  low: number;
  medium: number;
  high: number;
  critical: number;
}

/** Per-key scan count summary for today. */
export interface KeyUsageSummary {
  keyId: string;
  today: number;
}

/** Platform-wide analytics dashboard payload. */
export interface DashboardResponse {
  scans: ScanCounts;
  riskDistribution: RiskDistribution;
  /** Per-key scan counts for today. Keys with zero scans today are omitted. */
  keyUsage: KeyUsageSummary[];
}

// ── Client config ─────────────────────────────────────────────────────────────

/** Configuration for FaultlineClient. */
export interface FaultlineClientConfig {
  /** API key — pass via `process.env.FAULTLINE_API_KEY` in production. */
  apiKey: string;
  /**
   * Base URL of the Faultline API server.
   * Defaults to `'http://localhost:3000'`.
   */
  baseUrl?: string;
}

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * Thrown by FaultlineClient when the server returns a non-2xx HTTP status.
 *
 * @example
 * ```ts
 * try {
 *   const result = await client.scan('some text');
 * } catch (err) {
 *   if (err instanceof FaultlineError) {
 *     console.error(`API error ${err.status}:`, err.message);
 *   }
 * }
 * ```
 */
export class FaultlineError extends Error {
  /** HTTP status code returned by the server. */
  readonly status: number;
  /** Raw response body (parsed JSON if available, otherwise the raw text). */
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const message =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as Record<string, unknown>).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${status}`;

    super(message);
    this.name = 'FaultlineError';
    this.status = status;
    this.body = body;
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * TypeScript client for the Faultline Pro API.
 *
 * All methods throw `FaultlineError` on non-2xx responses.
 *
 * @example
 * ```ts
 * import { FaultlineClient } from '@nxtg/faultline-sdk';
 *
 * const client = new FaultlineClient({
 *   apiKey: process.env.FAULTLINE_API_KEY!,
 * });
 *
 * const result = await client.scan('GPT-4 was released in March 2023.');
 * console.log(result.overallRisk);
 * ```
 */
export class FaultlineClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: FaultlineClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'http://localhost:3000';
  }

  // ── Internal request helper ───────────────────────────────────────────────

  /**
   * Execute an HTTP request against the Faultline API.
   *
   * Sets `x-api-key` on every request and `Content-Type: application/json`
   * when a body is provided. Throws `FaultlineError` on non-2xx responses.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }
      throw new FaultlineError(response.status, errorBody);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Execute a request and return an ArrayBuffer (used for binary responses
   * such as the PDF compliance report).
   */
  private async requestBuffer(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ArrayBuffer> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }
      throw new FaultlineError(response.status, errorBody);
    }

    return response.arrayBuffer();
  }

  // ── Keys (admin only) ─────────────────────────────────────────────────────

  /**
   * Create a new API key.
   *
   * Returns the full `ApiKey` record including the raw `key` value.
   * Store it securely — it cannot be retrieved again.
   *
   * Requires admin permission.
   *
   * @param name - Human-readable label for the key.
   * @param permissions - Permissions to grant. Defaults to `['scan']`.
   */
  async createKey(
    name: string,
    permissions?: Permission[],
  ): Promise<ApiKey> {
    return this.request<ApiKey>('POST', '/keys', {
      name,
      ...(permissions !== undefined ? { permissions } : {}),
    });
  }

  /**
   * List all API keys registered in the keystore.
   *
   * The raw key value is omitted from list responses.
   * Requires admin permission.
   */
  async listKeys(): Promise<ApiKey[]> {
    return this.request<ApiKey[]>('GET', '/keys');
  }

  /**
   * Permanently delete an API key.
   *
   * Any in-flight requests using the deleted key will immediately begin
   * returning 401. Requires admin permission.
   *
   * @param id - UUID of the key to delete.
   */
  async deleteKey(id: string): Promise<void> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
    };

    const response = await fetch(`${this.baseUrl}/keys/${id}`, {
      method: 'DELETE',
      headers,
    });

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }
      throw new FaultlineError(response.status, errorBody);
    }
  }

  // ── Scan ──────────────────────────────────────────────────────────────────

  /**
   * Scan text for AI claim forensics.
   *
   * Extracts atomic claims, verifies each against live web sources, and
   * returns a structured risk scorecard with EU AI Act compliance mappings
   * and rule engine findings.
   *
   * Rate limited per key/tier.
   *
   * @param text - AI-generated text to analyse (1–50,000 characters).
   * @param provider - LLM provider to use. Defaults to server-configured default.
   */
  async scan(text: string, provider?: Provider): Promise<ScanResult> {
    return this.request<ScanResult>('POST', '/scan', {
      text,
      ...(provider !== undefined ? { provider } : {}),
    });
  }

  /**
   * Scan multiple texts concurrently in a single request.
   *
   * Accepts 1–10 texts. Results are returned for all items regardless of
   * individual failures. HTTP 200 is always returned — inspect `failed` and
   * `errors` for partial failure details.
   *
   * Each text counts as one scan against the rate-limit quota.
   *
   * @param texts - Array of 1–10 texts to scan.
   * @param provider - LLM provider to use.
   */
  async scanBatch(
    texts: string[],
    provider?: Provider,
  ): Promise<BatchScanResponse> {
    return this.request<BatchScanResponse>('POST', '/scan/batch', {
      texts,
      ...(provider !== undefined ? { provider } : {}),
    });
  }

  /**
   * Generate a PDF compliance report for the provided text.
   *
   * Runs the full claim forensics pipeline (identical to `scan()`) and
   * returns the result as a formatted PDF `ArrayBuffer`.
   *
   * @param text - AI-generated text to analyse.
   * @param provider - LLM provider to use.
   * @param projectName - Optional project name shown on the report cover page.
   */
  async scanReport(
    text: string,
    provider?: Provider,
    projectName?: string,
  ): Promise<ArrayBuffer> {
    return this.requestBuffer('POST', '/scan/report', {
      text,
      ...(provider !== undefined ? { provider } : {}),
      ...(projectName !== undefined ? { projectName } : {}),
    });
  }

  // ── Scan Diff ─────────────────────────────────────────────────────────────

  /**
   * Compare two texts at the claim level.
   *
   * Scans both texts and returns new, removed, and changed claims
   * with an inline diff view.
   *
   * @param before - Baseline text.
   * @param after - Comparison text.
   * @param provider - LLM provider to use.
   */
  async scanDiff(
    before: string,
    after: string,
    provider?: Provider,
  ): Promise<ScanDiffResult> {
    return this.request<ScanDiffResult>('POST', '/scan/diff', {
      before,
      after,
      ...(provider !== undefined ? { provider } : {}),
    });
  }

  /**
   * Deep scan with multi-provider chain and evidence linking.
   *
   * Uses the circuit breaker to try providers in order. Returns the scan
   * result enriched with `evidenceLinks` containing validated source URLs.
   *
   * @param text - AI-generated text to analyse.
   * @param provider - Preferred provider (falls back through chain on failure).
   */
  async scanDeep(
    text: string,
    provider?: Provider,
  ): Promise<ScanResult & { evidenceLinks: Array<Record<string, unknown>> }> {
    return this.request<ScanResult & { evidenceLinks: Array<Record<string, unknown>> }>(
      'POST',
      '/scan/deep',
      {
        text,
        ...(provider !== undefined ? { provider } : {}),
      },
    );
  }

  // ── Compliance Gate ──────────────────────────────────────────────────────

  /**
   * Scan text and evaluate EU AI Act compliance in a single call.
   *
   * Returns HTTP 200 on pass and HTTP 422 on fail. This method normalises
   * both into a `ComplianceGateResponse` — check `response.gate.pass`
   * to determine the outcome.
   *
   * @param text - AI-generated text to analyse.
   * @param options - Optional provider, project name, threshold, strict mode.
   */
  async complianceGate(
    text: string,
    options?: {
      provider?: Provider;
      projectName?: string;
      threshold?: number;
      strict?: boolean;
    },
  ): Promise<ComplianceGateResponse> {
    try {
      return await this.request<ComplianceGateResponse>(
        'POST',
        '/scan/compliance-gate',
        {
          text,
          ...options,
        },
      );
    } catch (err) {
      if (err instanceof FaultlineError && err.status === 422) {
        return err.body as ComplianceGateResponse;
      }
      throw err;
    }
  }

  /**
   * Evaluate EU AI Act compliance for an existing scan result.
   *
   * @param scanId - ID of a previously stored scan.
   * @param options - Optional project name, threshold, strict mode.
   */
  async getScanCompliance(
    scanId: string,
    options?: {
      projectName?: string;
      threshold?: number;
      strict?: boolean;
    },
  ): Promise<ComplianceGateResponse> {
    const params = new URLSearchParams();
    if (options?.projectName) params.set('projectName', options.projectName);
    if (options?.threshold !== undefined) params.set('threshold', String(options.threshold));
    if (options?.strict !== undefined) params.set('strict', String(options.strict));
    const qs = params.toString();
    const path = `/scan/${scanId}/compliance${qs ? `?${qs}` : ''}`;
    try {
      return await this.request<ComplianceGateResponse>('GET', path);
    } catch (err) {
      if (err instanceof FaultlineError && err.status === 422) {
        return err.body as ComplianceGateResponse;
      }
      throw err;
    }
  }

  /**
   * Compare EU AI Act compliance between two scans.
   *
   * @param beforeId - ID of the baseline scan.
   * @param afterId - ID of the comparison scan.
   * @param projectName - Optional project name.
   */
  async complianceDiff(
    beforeId: string,
    afterId: string,
    projectName?: string,
  ): Promise<ComplianceDiffResult> {
    return this.request<ComplianceDiffResult>('POST', '/scan/compliance-diff', {
      beforeId,
      afterId,
      ...(projectName !== undefined ? { projectName } : {}),
    });
  }

  /**
   * Fetch SVG compliance badge for a scan result.
   *
   * @param scanId - ID of a previously stored scan.
   * @param label - Optional custom label (default: 'EU AI Act').
   */
  async complianceBadge(scanId: string, label?: string): Promise<string> {
    const params = new URLSearchParams();
    if (label) params.set('label', label);
    const qs = params.toString();
    const path = `/scan/${scanId}/compliance/badge${qs ? `?${qs}` : ''}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { 'x-api-key': this.apiKey },
    });
    if (!response.ok) {
      throw new FaultlineError(response.status, await response.text());
    }
    return response.text();
  }

  /**
   * Query compliance gate evaluation history.
   *
   * @param options - Optional project name, limit, since (ISO 8601).
   */
  async complianceHistory(options?: {
    projectName?: string;
    limit?: number;
    since?: string;
  }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (options?.projectName) params.set('projectName', options.projectName);
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.since) params.set('since', options.since);
    const qs = params.toString();
    return this.request<Record<string, unknown>>('GET', `/compliance/history${qs ? `?${qs}` : ''}`);
  }

  /**
   * Get compliance score trend direction for a project.
   *
   * @param projectName - The project name to get trend for.
   */
  async complianceTrend(projectName: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'GET',
      `/compliance/trend?projectName=${encodeURIComponent(projectName)}`,
    );
  }

  /**
   * List upcoming regulatory compliance deadlines.
   *
   * @param days - Look-ahead window in days (default: 365).
   */
  async complianceDeadlines(days?: number): Promise<{ deadlines: ComplianceDeadline[] }> {
    const path = days !== undefined ? `/compliance/deadlines?days=${days}` : '/compliance/deadlines';
    return this.request<{ deadlines: ComplianceDeadline[] }>('GET', path);
  }

  // ── Claims ───────────────────────────────────────────────────────────────

  /**
   * Fetch trending claims, emerging patterns, and verdict changes.
   */
  async claimsTrending(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/claims/trending');
  }

  // ── GDPR ─────────────────────────────────────────────────────────────────

  /**
   * Download a GDPR Article 15 data export ZIP for a tenant.
   *
   * @param tenantId - ID of the tenant to export.
   * @returns ArrayBuffer containing the ZIP archive.
   */
  async gdprExport(tenantId: string): Promise<ArrayBuffer> {
    return this.requestBuffer('GET', `/tenants/${tenantId}/export`);
  }

  /**
   * Delete all data held for a tenant (GDPR Article 17 — Right to Erasure).
   *
   * @param tenantId - ID of the tenant whose data should be erased.
   */
  async gdprErase(tenantId: string): Promise<GdprErasureResult> {
    return this.request<GdprErasureResult>('DELETE', `/tenants/${tenantId}/data`);
  }

  // ── Usage / Dashboard ─────────────────────────────────────────────────────

  /**
   * Get per-day scan usage for the authenticated key.
   *
   * `usage` maps ISO date strings (YYYY-MM-DD) to scan counts.
   * Any authenticated key can call this — each key sees only its own usage.
   */
  async getUsage(): Promise<UsageResponse> {
    return this.request<UsageResponse>('GET', '/usage');
  }

  /**
   * Get platform-wide analytics dashboard.
   *
   * Returns aggregated scan counts (today/7-day/30-day), overall risk
   * distribution across all scans, and per-key scan counts for today.
   *
   * Requires admin permission.
   */
  async getDashboard(): Promise<DashboardResponse> {
    return this.request<DashboardResponse>('GET', '/dashboard');
  }

  // ── Webhooks (admin only) ─────────────────────────────────────────────────

  /**
   * Register a new webhook endpoint.
   *
   * An HMAC-SHA256 signing secret is generated automatically if not supplied.
   * The `secret` field is only present in the creation response — store it
   * securely. Requires admin permission.
   *
   * @param url - HTTPS endpoint to receive webhook deliveries.
   * @param events - Event types to subscribe to.
   * @param secret - Optional HMAC signing secret.
   */
  async createWebhook(
    url: string,
    events: WebhookEvent[],
    secret?: string,
  ): Promise<Webhook> {
    return this.request<Webhook>('POST', '/webhooks', {
      url,
      events,
      ...(secret !== undefined ? { secret } : {}),
    });
  }

  /**
   * List all registered webhook endpoints.
   *
   * The HMAC signing secret is omitted from list responses.
   * Requires admin permission.
   */
  async listWebhooks(): Promise<WebhookPublic[]> {
    return this.request<WebhookPublic[]>('GET', '/webhooks');
  }

  /**
   * Permanently delete a webhook registration.
   *
   * No further deliveries will be sent to the associated URL.
   * Requires admin permission.
   *
   * @param id - UUID of the webhook to delete.
   */
  async deleteWebhook(id: string): Promise<void> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
    };

    const response = await fetch(`${this.baseUrl}/webhooks/${id}`, {
      method: 'DELETE',
      headers,
    });

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }
      throw new FaultlineError(response.status, errorBody);
    }
  }
}
