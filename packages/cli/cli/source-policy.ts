/**
 * An optional allowlist for Parallel's Search API (providers/parallel_search_retriever.ts).
 *
 * Wire fields, from the v1 Search API reference and the Source Policy page on
 * docs.parallel.ai, read 2026-11-17:
 *   advanced_settings.source_policy.include_domains
 *   advanced_settings.source_policy.exclude_domains
 *   advanced_settings.source_policy.after_date   (YYYY-MM-DD)
 * include_domains is a hard allowlist. exclude_domains also applies inside it.
 * after_date keeps pages published on or after that day. fetch_policy is a
 * different setting and is never sent.
 *
 * Unset means no policy: the retriever does not read this module's env var.
 * A caller (the local CLI, the hosted API) passes a policy only when one is
 * configured. An unusable value does not mean "search the open web".
 */
import type { SourcePolicyVerdictReason, VerificationResult, VerdictProvenance } from '../types';
import { SOURCE_POLICY_MISS_EXPLANATION } from '../providers/retrieval-error';
import { groundingFromEnv } from './grounding.js';

/** Allowlist miss. PR #146 displays this as "no allowed source found". Set with `apiError: false`. */
export const SOURCE_POLICY_NO_MATCH_REASON: SourcePolicyVerdictReason = 'source_policy_no_match';

/** A policy was set but this scan would not search with Parallel. Set with `apiError: false`. */
export const SOURCE_POLICY_NOT_APPLIED_REASON: SourcePolicyVerdictReason = 'source_policy_not_applied';

/**
 * Scan-level warning when a policy is set and grounding is not Parallel.
 * Also the claim explanation. The open web is not searched.
 */
export const SOURCE_POLICY_NOT_PARALLEL_WARNING =
  'A source policy is set, but this scan is not using Parallel search, so no claim was checked. The open web was not searched.';

/**
 * Scan-level warning when consensus would retrieve with OpenAI web search.
 * A source policy does not cover that retriever, so nothing is checked.
 */
export const SOURCE_POLICY_OPENAI_CONSENSUS_WARNING =
  'A source policy is set, but consensus would use OpenAI web search, which a source policy does not cover, so no claim was checked. The open web was not searched.';

/** The env var a local run reads. The hosted API does not: a key carries the policy. */
export const SOURCE_POLICY_ENV = 'FAULTLINE_SOURCE_POLICY';

/** The one built-in profile. Anything else is a custom allowlist or unusable. */
export const HEALTHCARE_AUTHORITY_PROFILE = 'healthcare-authority' as const;
export type SourcePolicyProfile = typeof HEALTHCARE_AUTHORITY_PROFILE;

/**
 * Apex domains whose pages, and their subdomains, count as authoritative for
 * a payer audit. Parallel matches an apex domain and its subdomains, and
 * ignores a leading www. This is not every health site: a state agency, a
 * payer, or a journal outside this list is not included.
 */
export const HEALTHCARE_AUTHORITY_DOMAINS = [
  'cms.gov',
  'ecfr.gov',
  'federalregister.gov',
  'govinfo.gov',
  'congress.gov',
  'hhs.gov',
  'ahrq.gov',
  'fda.gov',
  'nih.gov',
  'cochranelibrary.com',
] as const;

/** Parallel refuses a request whose include and exclude lists together pass 200. */
const MAX_DOMAIN_ENTRIES = 200;

const OFF_VALUES = new Set(['off', 'none', 'open', 'unset']);

/**
 * A policy the retriever can send. `includeDomains` is never empty.
 * `excludeDomains` is always present (it may be empty) so a caller can filter
 * without a missing-field check. `invalid` is absent.
 */
export interface SourcePolicy {
  profile?: SourcePolicyProfile;
  includeDomains: string[];
  excludeDomains: string[];
  afterDate?: string;
  /**
   * The configured value could not be used. The retriever must not search.
   * Absent on a policy that can be sent.
   */
  invalid?: true;
}

/** The shape stored on an API key and copied onto verdict provenance. */
export interface StoredSourcePolicy {
  profile?: SourcePolicyProfile;
  includeDomains: string[];
  excludeDomains?: string[];
  afterDate?: string;
}

/** What a verdict records when a policy was applied. Omitted fields were not sent. */
export type ProvenanceSourcePolicy = StoredSourcePolicy;

export class SourcePolicyError extends Error {
  constructor() {
    super('invalid source policy');
    this.name = 'SourcePolicyError';
  }
}

/** True for a policy that may be sent. An invalid or empty value is not. */
export function isActiveSourcePolicy(policy: SourcePolicy | null | undefined): policy is SourcePolicy {
  return !!policy && policy.invalid !== true && policy.includeDomains.length > 0;
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1];
  if (!tld || !/^[a-z]{2,63}$/.test(tld)) return false;
  return labels.every((label) => HOST_LABEL.test(label));
}

interface DomainRule {
  host?: string;
  path?: string;
  extension?: string;
  wire: string;
}

/**
 * One include or exclude entry, in the form Parallel accepts: a domain, a
 * domain plus a path, or a bare extension (`.gov`). No scheme, port, query
 * or fragment. The host is lowercased and a leading `www.` is dropped, which
 * is how Parallel compares entries.
 */
function parseDomainRule(raw: string): DomainRule | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return null;
  if (/[^\x21-\x7e]/.test(trimmed)) return null;
  if (/[\s?#:@]|:\/\/|\\|\*/.test(trimmed)) return null;
  if (trimmed.startsWith('.')) {
    const rest = trimmed.slice(1);
    if (!rest || rest.startsWith('.') || rest.endsWith('.')) return null;
    const labels = rest.split('.');
    if (!labels.every((label) => HOST_LABEL.test(label))) return null;
    const extension = `.${labels.join('.')}`;
    return { extension, wire: extension };
  }
  const slash = trimmed.indexOf('/');
  const hostRaw = (slash === -1 ? trimmed : trimmed.slice(0, slash)).toLowerCase().replace(/^www\./, '');
  if (!validHost(hostRaw)) return null;
  if (slash === -1) return { host: hostRaw, wire: hostRaw };
  const path = normalizePath(trimmed.slice(slash));
  if (!path || path === '/') return { host: hostRaw, wire: hostRaw };
  return { host: hostRaw, path, wire: `${hostRaw}${path}` };
}

/** Dot segments resolved, trailing slash dropped, other spelling kept. Null when the path escapes the root. */
function normalizePath(pathname: string): string | null {
  const parts: string[] = [];
  for (const segment of pathname.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

function ruleMatches(host: string, path: string, rule: DomainRule): boolean {
  if (rule.extension) return host.endsWith(rule.extension);
  if (!rule.host) return false;
  const hostOk = host === rule.host || host.endsWith(`.${rule.host}`);
  if (!hostOk) return false;
  if (!rule.path) return true;
  return path === rule.path || path.startsWith(`${rule.path}/`);
}

function urlHostPath(uri: string): { host: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = normalizePath(url.pathname);
  if (!path) return null;
  return { host, path };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map((part) => Number(part));
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function rulesFromList(value: unknown): DomainRule[] | null {
  if (!Array.isArray(value)) return null;
  const rules: DomainRule[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const rule = parseDomainRule(entry);
    if (!rule || seen.has(rule.wire)) {
      if (!rule) return null;
      continue;
    }
    seen.add(rule.wire);
    rules.push(rule);
  }
  return rules;
}

function sameWires(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((wire, i) => wire === b[i]);
}

interface PolicyFields {
  profile?: unknown;
  include?: unknown;
  exclude?: unknown;
  after?: unknown;
}

function fieldsFromObject(value: Record<string, unknown>): PolicyFields | null {
  const allowed = new Set([
    'profile', 'includeDomains', 'include_domains', 'excludeDomains', 'exclude_domains', 'afterDate', 'after_date',
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) return null;
  const include = pickOne(value, 'includeDomains', 'include_domains');
  const exclude = pickOne(value, 'excludeDomains', 'exclude_domains');
  const after = pickOne(value, 'afterDate', 'after_date');
  if (include === CONFLICT || exclude === CONFLICT || after === CONFLICT) return null;
  return {
    profile: value.profile,
    include: include === ABSENT ? undefined : include,
    exclude: exclude === ABSENT ? undefined : exclude,
    after: after === ABSENT ? undefined : after,
  };
}

const ABSENT = Symbol('absent');
const CONFLICT = Symbol('conflict');

function pickOne(value: Record<string, unknown>, camel: string, snake: string): unknown {
  const hasCamel = Object.prototype.hasOwnProperty.call(value, camel);
  const hasSnake = Object.prototype.hasOwnProperty.call(value, snake);
  if (hasCamel && hasSnake) {
    return JSON.stringify(value[camel]) === JSON.stringify(value[snake]) ? value[camel] : CONFLICT;
  }
  if (hasCamel) return value[camel];
  if (hasSnake) return value[snake];
  return ABSENT;
}

function policyFromFields(fields: PolicyFields): SourcePolicy {
  const invalid = (): SourcePolicy => ({ includeDomains: [], excludeDomains: [], invalid: true });
  let profile: SourcePolicyProfile | undefined;
  if (fields.profile !== undefined) {
    if (fields.profile !== HEALTHCARE_AUTHORITY_PROFILE) return invalid();
    profile = HEALTHCARE_AUTHORITY_PROFILE;
  }
  const includeRules = fields.include === undefined
    ? null
    : rulesFromList(fields.include);
  if (fields.include !== undefined && !includeRules) return invalid();
  const excludeRules = fields.exclude === undefined ? [] : rulesFromList(fields.exclude);
  if (!excludeRules) return invalid();
  let include = includeRules;
  if (!include && profile) {
    include = HEALTHCARE_AUTHORITY_DOMAINS.map((domain) => parseDomainRule(domain)!);
  }
  if (!include || include.length === 0) return invalid();
  if (include.length + excludeRules.length > MAX_DOMAIN_ENTRIES) return invalid();
  const includeWires = include.map((rule) => rule.wire);
  const excludeWires = excludeRules.map((rule) => rule.wire);
  if (excludeWires.some((wire) => includeWires.includes(wire))) return invalid();
  let afterDate: string | undefined;
  if (fields.after !== undefined && fields.after !== null) {
    if (typeof fields.after !== 'string' || !isIsoDate(fields.after)) return invalid();
    afterDate = fields.after;
  }
  const profileDomains: readonly string[] = HEALTHCARE_AUTHORITY_DOMAINS;
  const keepProfile = profile === HEALTHCARE_AUTHORITY_PROFILE && sameWires(includeWires, profileDomains);
  return {
    ...(keepProfile ? { profile: HEALTHCARE_AUTHORITY_PROFILE } : {}),
    includeDomains: includeWires,
    excludeDomains: excludeWires,
    ...(afterDate ? { afterDate } : {}),
  };
}

function policyFromString(value: string): SourcePolicy | null {
  const trimmed = value.trim();
  if (trimmed === '' || OFF_VALUES.has(trimmed.toLowerCase())) return null;
  if (trimmed.toLowerCase() === HEALTHCARE_AUTHORITY_PROFILE) {
    return policyFromFields({ profile: HEALTHCARE_AUTHORITY_PROFILE });
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { includeDomains: [], excludeDomains: [], invalid: true };
      }
      return parseSourcePolicy(parsed);
    } catch {
      return { includeDomains: [], excludeDomains: [], invalid: true };
    }
  }
  if (trimmed.includes(',')) {
    return policyFromFields({ include: trimmed.split(',').map((part) => part.trim()).filter((part) => part.length > 0) });
  }
  const one = parseDomainRule(trimmed);
  if (!one) return { includeDomains: [], excludeDomains: [], invalid: true };
  return policyFromFields({ include: [one.wire] });
}

/**
 * Read a policy from an env string, a JSON object, or a stored key field.
 * `null` means no policy (unset, blank, `off`, `none`, `open`). An unusable
 * value is `{ invalid: true }`, which the retriever refuses to search with.
 */
export function parseSourcePolicy(value: unknown): SourcePolicy | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return policyFromString(value);
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { includeDomains: [], excludeDomains: [], invalid: true };
  }
  const fields = fieldsFromObject(value as Record<string, unknown>);
  if (!fields) return { includeDomains: [], excludeDomains: [], invalid: true };
  // An empty object was sent as a policy. That is not "no policy": no policy is
  // the field being absent. An empty object must not search the open web.
  if (fields.profile === undefined && fields.include === undefined && fields.exclude === undefined && fields.after === undefined) {
    return { includeDomains: [], excludeDomains: [], invalid: true };
  }
  return policyFromFields(fields);
}

/** The policy `FAULTLINE_SOURCE_POLICY` names in `env`, or null when unset or blank. */
export function sourcePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SourcePolicy | null {
  const raw = env[SOURCE_POLICY_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  return parseSourcePolicy(raw);
}

/** A usable policy, or SourcePolicyError. `null` and an invalid value both throw. */
export function assertSourcePolicy(value: unknown): SourcePolicy {
  const parsed = parseSourcePolicy(value);
  if (!isActiveSourcePolicy(parsed)) throw new SourcePolicyError();
  return parsed;
}

/** The object written on a key and on provenance: no empty exclude list, no invalid flag. */
export function storedSourcePolicy(policy: SourcePolicy): StoredSourcePolicy {
  if (!isActiveSourcePolicy(policy)) throw new SourcePolicyError();
  return {
    ...(policy.profile ? { profile: policy.profile } : {}),
    includeDomains: [...policy.includeDomains],
    ...(policy.excludeDomains.length > 0 ? { excludeDomains: [...policy.excludeDomains] } : {}),
    ...(policy.afterDate ? { afterDate: policy.afterDate } : {}),
  };
}

/**
 * True when `value` is already the stored shape of a usable policy. A keystore
 * record that fails this is refused, the same as any other field out of shape.
 */
export function isStorableSourcePolicy(value: unknown): value is StoredSourcePolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== 'profile' && key !== 'includeDomains' && key !== 'excludeDomains' && key !== 'afterDate') return false;
  }
  if (!Array.isArray(rec.includeDomains)) return false;
  const parsed = parseSourcePolicy(value);
  if (!isActiveSourcePolicy(parsed)) return false;
  let stored: StoredSourcePolicy;
  try {
    stored = storedSourcePolicy(parsed);
  } catch {
    return false;
  }
  return JSON.stringify(stored) === JSON.stringify(rec);
}

/**
 * The `source_policy` object Parallel accepts. Key order is fixed. Empty
 * exclude and a missing date are omitted, so they are not sent as null.
 */
export function wireSourcePolicy(policy: SourcePolicy): { include_domains: string[]; exclude_domains?: string[]; after_date?: string } {
  return {
    include_domains: [...policy.includeDomains],
    ...(policy.excludeDomains.length > 0 ? { exclude_domains: [...policy.excludeDomains] } : {}),
    ...(policy.afterDate ? { after_date: policy.afterDate } : {}),
  };
}

/**
 * True when a retrieved page is inside the allowlist, outside the exclude
 * list, and (when an after-date is set) dated on or after that day. A page
 * with no publish date does not pass an after-date: an undated page is not
 * treated as recent. A URL the reader cannot open does not pass.
 */
export function sourceSatisfiesPolicy(uri: string, publishDate: string | undefined, policy: SourcePolicy): boolean {
  if (!isActiveSourcePolicy(policy)) return false;
  const parts = urlHostPath(uri);
  if (!parts) return false;
  const include = policy.includeDomains.map((wire) => parseDomainRule(wire)).filter((rule): rule is DomainRule => rule !== null);
  const exclude = policy.excludeDomains.map((wire) => parseDomainRule(wire)).filter((rule): rule is DomainRule => rule !== null);
  if (!include.some((rule) => ruleMatches(parts.host, parts.path, rule))) return false;
  if (exclude.some((rule) => ruleMatches(parts.host, parts.path, rule))) return false;
  if (policy.afterDate) {
    if (!publishDate) return false;
    const day = publishDate.slice(0, 10);
    if (!isIsoDate(day) || day < policy.afterDate) return false;
  }
  return true;
}

/**
 * An allowlist miss: unverified, not an outage, and the policy is on the
 * provenance so a reader can see what was required.
 */
export function sourcePolicyNoMatchResult(claimId: string, provenance: VerdictProvenance): VerificationResult {
  return {
    claimId,
    status: 'unverified',
    explanation: SOURCE_POLICY_MISS_EXPLANATION,
    sources: [],
    apiError: false,
    apiErrorReason: SOURCE_POLICY_NO_MATCH_REASON,
    provenance,
  };
}

/**
 * A policy that this scan cannot apply. `warning` is the scan-level text.
 * No web search runs.
 */
export function sourcePolicyNotAppliedResult(claimId: string, warning: string, provenance: VerdictProvenance): VerificationResult {
  return {
    claimId,
    status: 'unverified',
    explanation: warning,
    sources: [],
    apiError: false,
    apiErrorReason: SOURCE_POLICY_NOT_APPLIED_REASON,
    provenance,
  };
}

/** The policy a retriever carried, in the provenance shape, or undefined when it had none. */
export function provenanceSourcePolicy(retriever: { sourcePolicy?: SourcePolicy | null }): ProvenanceSourcePolicy | undefined {
  const policy = retriever.sourcePolicy;
  if (!isActiveSourcePolicy(policy)) return undefined;
  return storedSourcePolicy(policy);
}

/**
 * What a local run adds on top of the caller's options: `grounding: 'parallel'`
 * when the user's env asks for it and the caller did not, and a source policy
 * when `FAULTLINE_SOURCE_POLICY` is set and the caller did not pass one.
 * Null when there is nothing to add, so the caller can invoke scan() unchanged.
 */
export function localGroundingAdditions(
  explicit?: { grounding?: 'google' | 'parallel'; sourcePolicy?: SourcePolicy | null },
): { grounding?: 'parallel'; sourcePolicy?: SourcePolicy } | null {
  const addParallel = explicit?.grounding === undefined && groundingFromEnv() === 'parallel';
  const hasExplicitPolicy = explicit != null && Object.prototype.hasOwnProperty.call(explicit, 'sourcePolicy');
  const policy = hasExplicitPolicy ? null : sourcePolicyFromEnv();
  if (!addParallel && !policy) return null;
  return {
    ...(addParallel ? { grounding: 'parallel' as const } : {}),
    ...(policy ? { sourcePolicy: policy } : {}),
  };
}
