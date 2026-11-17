/**
 * The Parallel source-policy allowlist (cli/source-policy.ts).
 *
 * Unset is no policy. A profile, a custom allowlist, an exclude list and an
 * after-date parse into the fields Parallel's Search API accepts. An unusable
 * value is refused, not treated as the open web.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  HEALTHCARE_AUTHORITY_DOMAINS,
  SOURCE_POLICY_ENV,
  assertSourcePolicy,
  isActiveSourcePolicy,
  isStorableSourcePolicy,
  localGroundingAdditions,
  parseSourcePolicy,
  provenanceSourcePolicy,
  sourcePolicyFromEnv,
  sourceSatisfiesPolicy,
  storedSourcePolicy,
  wireSourcePolicy,
  type SourcePolicy,
} from '../cli/source-policy';
import { SourcePolicyError } from '../cli/source-policy';

const healthcare = (): SourcePolicy => {
  const parsed = parseSourcePolicy('healthcare-authority');
  if (!parsed || parsed.invalid) throw new Error('profile did not parse');
  return parsed;
};

afterEach(() => {
  delete process.env.FAULTLINE_GROUNDING;
  delete process.env.FAULTLINE_SOURCE_POLICY;
});

describe('parseSourcePolicy', () => {
  it('unset, blank and the off words are no policy', () => {
    expect(parseSourcePolicy(undefined)).toBeNull();
    expect(parseSourcePolicy(null)).toBeNull();
    expect(parseSourcePolicy('')).toBeNull();
    expect(parseSourcePolicy('  ')).toBeNull();
    for (const word of ['off', 'NONE', ' open ', 'unset']) expect(parseSourcePolicy(word)).toBeNull();
    expect(sourcePolicyFromEnv({})).toBeNull();
    expect(sourcePolicyFromEnv({ [SOURCE_POLICY_ENV]: '' })).toBeNull();
  });

  it('healthcare-authority is the built-in allowlist, in that order, with no exclude or date', () => {
    const policy = healthcare();
    expect(policy.profile).toBe('healthcare-authority');
    expect(policy.includeDomains).toEqual([...HEALTHCARE_AUTHORITY_DOMAINS]);
    expect(policy.excludeDomains).toEqual([]);
    expect(policy.afterDate).toBeUndefined();
    expect(policy.includeDomains).toContain('cms.gov');
    expect(policy.includeDomains).toContain('cochranelibrary.com');
    expect(wireSourcePolicy(policy)).toEqual({ include_domains: [...HEALTHCARE_AUTHORITY_DOMAINS] });
    expect(JSON.stringify(wireSourcePolicy(policy))).not.toContain('exclude_domains');
    expect(JSON.stringify(wireSourcePolicy(policy))).not.toContain('after_date');
    expect(JSON.stringify(wireSourcePolicy(policy))).not.toContain('fetch_policy');
  });

  it('reads a JSON object in either field spelling, and a comma-separated allowlist', () => {
    const fromJson = parseSourcePolicy('{"profile":"healthcare-authority","exclude_domains":["cms.gov/archive"],"after_date":"2024-01-01"}');
    expect(isActiveSourcePolicy(fromJson)).toBe(true);
    expect(fromJson).toMatchObject({
      profile: 'healthcare-authority',
      excludeDomains: ['cms.gov/archive'],
      afterDate: '2024-01-01',
    });
    expect(fromJson!.includeDomains).toEqual([...HEALTHCARE_AUTHORITY_DOMAINS]);
    const custom = parseSourcePolicy({ includeDomains: ['www.FDA.gov', 'cms.gov'], excludeDomains: ['fda.gov/tobacco'], afterDate: '2020-02-29' });
    expect(custom).toEqual({
      includeDomains: ['fda.gov', 'cms.gov'],
      excludeDomains: ['fda.gov/tobacco'],
      afterDate: '2020-02-29',
    });
    expect(parseSourcePolicy('nih.gov, www.fda.gov')).toEqual({
      includeDomains: ['nih.gov', 'fda.gov'],
      excludeDomains: [],
    });
    expect(wireSourcePolicy(custom!)).toEqual({
      include_domains: ['fda.gov', 'cms.gov'],
      exclude_domains: ['fda.gov/tobacco'],
      after_date: '2020-02-29',
    });
  });

  it('an unusable value is invalid, not the open web', () => {
    for (const value of [
      'not-a-policy',
      'https://cms.gov',
      'cms.gov:443',
      '*.gov',
      { includeDomains: [] },
      { includeDomains: ['cms.gov'], excludeDomains: ['www.cms.gov'] },
      { includeDomains: ['cms.gov'], afterDate: '2024-02-31' },
      { includeDomains: ['cms.gov'], surprise: true },
      { profile: 'every-hospital' },
      {},
      ['cms.gov'],
    ]) {
      const parsed = parseSourcePolicy(value as never);
      expect(parsed === null, JSON.stringify(value)).toBe(false);
      expect(isActiveSourcePolicy(parsed)).toBe(false);
      expect(parsed?.invalid).toBe(true);
    }
    expect(() => assertSourcePolicy('nope')).toThrow(SourcePolicyError);
    expect(assertSourcePolicy(' Healthcare-Authority ').profile).toBe('healthcare-authority');
  });

  it('the stored shape round-trips, and a non-canonical value does not', () => {
    const stored = storedSourcePolicy(healthcare());
    expect(isStorableSourcePolicy(stored)).toBe(true);
    expect(parseSourcePolicy(stored)).toEqual(healthcare());
    const withExtras = storedSourcePolicy(assertSourcePolicy({
      includeDomains: ['hhs.gov'],
      excludeDomains: ['hhs.gov/archive'],
      afterDate: '2023-01-01',
    }));
    expect(isStorableSourcePolicy(withExtras)).toBe(true);
    expect(isStorableSourcePolicy({ includeDomains: ['WWW.CMS.gov'] })).toBe(false);
    expect(isStorableSourcePolicy({ profile: 'healthcare-authority' })).toBe(false);
    expect(isStorableSourcePolicy({ includeDomains: ['cms.gov'], note: 'x' })).toBe(false);
  });
});

describe('sourceSatisfiesPolicy', () => {
  const policy = healthcare();

  it('matches an apex domain, its subdomains and a leading www, and not a lookalike', () => {
    expect(sourceSatisfiesPolicy('https://www.cms.gov/medicare', '2024-01-01', policy)).toBe(true);
    expect(sourceSatisfiesPolicy('https://pubmed.ncbi.nlm.nih.gov/123', undefined, policy)).toBe(true);
    expect(sourceSatisfiesPolicy('https://www.cochranelibrary.com/cdsr', undefined, policy)).toBe(true);
    expect(sourceSatisfiesPolicy('https://notcms.gov/x', undefined, policy)).toBe(false);
    expect(sourceSatisfiesPolicy('https://cms.gov.evil.example/x', undefined, policy)).toBe(false);
    expect(sourceSatisfiesPolicy('https://evil.com/cms.gov', undefined, policy)).toBe(false);
    expect(sourceSatisfiesPolicy('https://news.example/cms', undefined, policy)).toBe(false);
    expect(sourceSatisfiesPolicy('ftp://cms.gov/x', undefined, policy)).toBe(false);
  });

  it('applies exclude at a path boundary and the after-date, dropping an undated page', () => {
    const custom = assertSourcePolicy({
      includeDomains: ['cms.gov', '.gov'],
      excludeDomains: ['cms.gov/archive'],
      afterDate: '2024-01-01',
    });
    expect(sourceSatisfiesPolicy('https://www.cms.gov/medicare', '2024-01-01', custom)).toBe(true);
    expect(sourceSatisfiesPolicy('https://www.cms.gov/archive/2020', '2024-06-01', custom)).toBe(false);
    expect(sourceSatisfiesPolicy('https://www.cms.gov/archive-notes', '2024-06-01', custom)).toBe(true);
    expect(sourceSatisfiesPolicy('https://www.fda.gov/drugs', '2024-06-01', custom)).toBe(true);
    expect(sourceSatisfiesPolicy('https://www.fda.gov/drugs', '2023-12-31', custom)).toBe(false);
    expect(sourceSatisfiesPolicy('https://www.fda.gov/drugs', undefined, custom)).toBe(false);
    expect(sourceSatisfiesPolicy('https://www.fda.gov/drugs', 'not-a-date', custom)).toBe(false);
    expect(sourceSatisfiesPolicy('https://example.com/x', '2024-06-01', custom)).toBe(false);
  });
});

describe('provenance and the local env', () => {
  it('records a usable policy and nothing for a retriever without one', () => {
    const recorded = provenanceSourcePolicy({ sourcePolicy: healthcare() });
    expect(recorded).toEqual({ profile: 'healthcare-authority', includeDomains: [...HEALTHCARE_AUTHORITY_DOMAINS] });
    expect(provenanceSourcePolicy({})).toBeUndefined();
    expect(provenanceSourcePolicy({ sourcePolicy: null })).toBeUndefined();
    expect(provenanceSourcePolicy({ sourcePolicy: { includeDomains: [], excludeDomains: [], invalid: true } })).toBeUndefined();
  });

  it('adds nothing when the env asks for nothing, and adds a policy without changing a caller that already set grounding', () => {
    expect(localGroundingAdditions()).toBeNull();
    expect(localGroundingAdditions({ grounding: 'google' })).toBeNull();
    process.env.FAULTLINE_SOURCE_POLICY = 'healthcare-authority';
    expect(localGroundingAdditions({ grounding: 'google', sourcePolicy: null })).toBeNull();
    const added = localGroundingAdditions({ grounding: 'google' });
    expect(added?.grounding).toBeUndefined();
    expect(added?.sourcePolicy?.profile).toBe('healthcare-authority');
    process.env.FAULTLINE_GROUNDING = 'parallel';
    expect(localGroundingAdditions()).toMatchObject({ grounding: 'parallel' });
    expect(localGroundingAdditions()?.sourcePolicy?.includeDomains[0]).toBe('cms.gov');
  });
});
