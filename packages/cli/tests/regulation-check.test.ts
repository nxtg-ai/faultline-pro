/**
 * Deterministic CFR, NCD and LCD check (evidence/regulation.ts).
 *
 * Every lookup is a fixture. The bodies were recorded 2026-11-17:
 *   - eCFR versions and section XML for 42 CFR 422.101, the empty versions
 *     list for 422.9999, and the title-99 404.
 *   - The CMS NCD report row for 220.6.17 (the live report that day listed
 *     345 NCDs and an empty next_token; the fixture keeps that row and the
 *     empty next_token, so the checker treats the fixture list as complete).
 *   - LCD L33797's id, version and title. The long LCD body fields are
 *     omitted: they can carry licensed code-set text. The license-agreement
 *     fixture keeps the measured shape (data[0].Token, a UUID) with a fixed
 *     token; the agreement text CMS returns in meta.notes is omitted.
 * No network.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider } from '../providers/registry.js';
import { runVerification, type Verifier } from '../cli/verify-runner.js';
import {
  LCD_LICENSE_URL,
  NCD_REPORT_URL,
  REGULATION_RETRIEVER,
  REGULATION_USER_AGENT,
  checkRegulationCitation,
  ecfrSectionUrl,
  ecfrVersionsUrl,
  lcdDocumentUrl,
  ncdDocumentUrl,
  regulationUrlAllowed,
  resolveRegulationCheck,
  type RegulationCheckOptions,
} from '../evidence/regulation.js';
import { doiHandleUrl, DOI_RETRIEVER, type DoiCheckOptions } from '../evidence/doi.js';
import { isBillableVerdict } from '../lib/verdict-guard.js';
import type { Claim, Source } from '../types.js';
import type { Retriever } from '../providers/base_provider.js';

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/regulation');
const fixture = (name: string) => readFileSync(join(root, name), 'utf8');

const VERSIONS_422 = ecfrVersionsUrl('42', '422', '422.101');
const XML_422 = ecfrSectionUrl('2026-06-01', '42', '422', '422.101');
const VERSIONS_MISSING = ecfrVersionsUrl('42', '422', '422.9999');
const VERSIONS_99 = ecfrVersionsUrl('99', '1', '1.1');
const LCD_33797 = lcdDocumentUrl('33797');
const NCD_DOC = ncdDocumentUrl('331', '4');

interface Call { url: string; init: RequestInit }

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(routes: Record<string, () => Response>): { opts: RegulationCheckOptions; calls: Call[] } {
  const calls: Call[] = [];
  const opts: RegulationCheckOptions = {
    fetch: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      const route = routes[url];
      if (!route) throw new Error(`unexpected request ${url}`);
      return route();
    },
  };
  return { opts, calls };
}

const recorded: Record<string, () => Response> = {
  [VERSIONS_422]: () => jsonResponse(200, fixture('ecfr-42-422.101-versions.json')),
  [XML_422]: () => new Response(fixture('ecfr-42-422.101.xml'), { status: 200, headers: { 'content-type': 'text/xml' } }),
  [VERSIONS_MISSING]: () => jsonResponse(200, fixture('ecfr-42-422.9999-versions.json')),
  [VERSIONS_99]: () => jsonResponse(404, fixture('ecfr-title-99.json')),
  [NCD_REPORT_URL]: () => jsonResponse(200, fixture('ncd-220.6.17.json')),
  [LCD_LICENSE_URL]: () => jsonResponse(200, fixture('license-agreement.json')),
  [LCD_33797]: () => jsonResponse(200, fixture('lcd-L33797.json')),
};

function claim(text: string, id = 'c1'): Claim {
  return { id, text, type: 'fact', importance: 3 };
}

function headersOf(call: Call): Record<string, string> {
  const headers = call.init.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  return Object.fromEntries(Object.entries(headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
}

describe('regulation URLs stay on the official hosts', () => {
  it('allows only the lookup URLs the checker builds', () => {
    for (const url of [VERSIONS_422, XML_422, NCD_REPORT_URL, LCD_LICENSE_URL, LCD_33797, NCD_DOC]) {
      expect(regulationUrlAllowed(url)).toBe(true);
    }
    expect(regulationUrlAllowed('https://www.ecfr.gov/api/versioner/v1/versions/title-42.json?part=422&section=422.101&x=1')).toBe(false);
    expect(regulationUrlAllowed('https://www.ecfr.gov/api/versioner/v1/versions/title-42.json/../../secret')).toBe(false);
    expect(regulationUrlAllowed('https://evil.example/v1/data/lcd/?lcdid=33797')).toBe(false);
    expect(regulationUrlAllowed('https://api.coverage.cms.gov/v1/data/lcd/?lcdid=33797&token=secret')).toBe(false);
  });
});

describe('checkRegulationCitation', () => {
  it('a real CFR paragraph is supported from the eCFR, and the lookup sends only the identifier', async () => {
    const { opts, calls } = fakeFetch(recorded);
    const result = await checkRegulationCitation(claim('See 42 CFR 422.101(c).'), opts);
    expect(result?.status).toBe('supported');
    expect(result?.explanation).toContain('Requirements relating to basic benefits');
    expect(result?.sources.map((s) => s.uri)).toEqual([XML_422, VERSIONS_422]);
    expect(result?.provenance?.retriever).toBe(REGULATION_RETRIEVER);
    expect(isBillableVerdict(result)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([VERSIONS_422, XML_422]);
    for (const call of calls) {
      expect(headersOf(call)).toEqual({ 'user-agent': REGULATION_USER_AGENT });
      expect(call.init.body).toBeUndefined();
      expect(call.init.method).toBe('GET');
    }
  });

  it('a nested paragraph that is in the section is supported', async () => {
    const { opts } = fakeFetch(recorded);
    const result = await checkRegulationCitation(claim('42 C.F.R. § 422.101(b)(3)(ii)'), opts);
    expect(result?.status).toBe('supported');
  });

  it('a quoted title that matches is supported, and one that does not is mixed', async () => {
    const match = await checkRegulationCitation(
      claim('42 CFR 422.101(c) "Requirements relating to basic benefits"'), fakeFetch(recorded).opts);
    expect(match?.status).toBe('supported');
    const mixed = await checkRegulationCitation(
      claim('42 CFR 422.101(c) "Glucose monitors for home use only"'), fakeFetch(recorded).opts);
    expect(mixed?.status).toBe('mixed');
    expect(mixed?.explanation).toContain('Requirements relating to basic benefits');
    expect(mixed?.explanation).not.toContain('Glucose monitors');
    expect(isBillableVerdict(mixed)).toBe(true);
  });

  it('a title too short to compare falls through', async () => {
    const { opts } = fakeFetch(recorded);
    expect(await checkRegulationCitation(claim('42 CFR 422.101(c) "Benefits"'), opts)).toBeNull();
  });

  it('a section that is not in the eCFR is contradicted, with the versions URL, and the section XML is not fetched', async () => {
    const { opts, calls } = fakeFetch(recorded);
    const text = '42 CFR 422.9999 Confidential-Merger-Project-Zephyr requires a secret benefit.';
    const result = await checkRegulationCitation(claim(text), opts);
    expect(result?.status).toBe('contradicted');
    expect(result?.sources).toEqual([{ title: 'eCFR versions lookup for 42 CFR 422.9999', uri: VERSIONS_MISSING }]);
    expect(calls.map((c) => c.url)).toEqual([VERSIONS_MISSING]);
    expect(JSON.stringify(calls)).not.toContain('Confidential');
    expect(JSON.stringify(calls)).not.toContain('Zephyr');
  });

  it('a paragraph the section does not have is contradicted, with the section URL', async () => {
    const { opts, calls } = fakeFetch(recorded);
    const result = await checkRegulationCitation(claim('42 CFR 422.101(z)'), opts);
    expect(result?.status).toBe('contradicted');
    expect(result?.explanation).toContain('no paragraph (z)');
    expect(result?.sources[0]!.uri).toBe(XML_422);
    expect(calls.map((c) => c.url)).toEqual([VERSIONS_422, XML_422]);
  });

  it('an unknown CFR title (HTTP 404 with the eCFR not-found body) is contradicted', async () => {
    const { opts } = fakeFetch(recorded);
    const result = await checkRegulationCitation(claim('99 CFR 1.1'), opts);
    expect(result?.status).toBe('contradicted');
    expect(result?.sources[0]!.uri).toBe(VERSIONS_99);
  });

  it('a removed section is contradicted', async () => {
    const body = JSON.parse(fixture('ecfr-42-422.101-versions.json')) as { content_versions: Array<{ removed: boolean }> };
    for (const row of body.content_versions) row.removed = true;
    const { opts } = fakeFetch({ [VERSIONS_422]: () => jsonResponse(200, JSON.stringify(body)) });
    const result = await checkRegulationCitation(claim('42 CFR 422.101'), opts);
    expect(result?.status).toBe('contradicted');
    expect(result?.explanation).toContain('removed');
  });

  it('a real citation inside a further assertion falls through, and a failed lookup falls through', async () => {
    const substantive = await checkRegulationCitation(
      claim('42 CFR 422.101(c) requires plans to cover every emergency service.'), fakeFetch(recorded).opts);
    expect(substantive).toBeNull();
    for (const status of [429, 500, 503]) {
      const { opts, calls } = fakeFetch({ [VERSIONS_MISSING]: () => jsonResponse(status, fixture('ecfr-42-422.9999-versions.json')) });
      expect(await checkRegulationCitation(claim('42 CFR 422.9999'), opts)).toBeNull();
      expect(calls).toHaveLength(1);
    }
    const redirected = fakeFetch({
      [VERSIONS_422]: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/take' } }),
    });
    expect(await checkRegulationCitation(claim('42 CFR 422.101'), redirected.opts)).toBeNull();
    const thrown = fakeFetch({});
    thrown.opts.fetch = async () => { throw new Error('network down'); };
    expect(await checkRegulationCitation(claim('42 CFR 422.101(c)'), thrown.opts)).toBeNull();
  });

  it('a section that exists but whose XML cannot be read falls through, even for a missing-looking paragraph', async () => {
    const { opts } = fakeFetch({
      [VERSIONS_422]: recorded[VERSIONS_422]!,
      [XML_422]: () => jsonResponse(503, '{}'),
    });
    expect(await checkRegulationCitation(claim('42 CFR 422.101(z)'), opts)).toBeNull();
  });

  it('a real NCD is supported and a missing one is contradicted from the report URL', async () => {
    const found = await checkRegulationCitation(claim('NCD 220.6.17'), fakeFetch(recorded).opts);
    expect(found?.status).toBe('supported');
    expect(found?.explanation).toContain('Positron Emission Tomography (FDG) for Oncologic Conditions');
    expect(found?.sources.map((s) => s.uri)).toEqual([NCD_DOC, NCD_REPORT_URL]);
    const { opts, calls } = fakeFetch(recorded);
    const missing = await checkRegulationCitation(claim('NCD 999.9.9'), opts);
    expect(missing?.status).toBe('contradicted');
    expect(missing?.sources).toEqual([{ title: 'CMS national coverage determination list', uri: NCD_REPORT_URL }]);
    expect(calls.map((c) => c.url)).toEqual([NCD_REPORT_URL]);
    expect(headersOf(calls[0]!)).toEqual({ 'user-agent': REGULATION_USER_AGENT });
  });

  it('an NCD title that does not match is mixed, and an unfinished report list is not a verdict', async () => {
    const mixed = await checkRegulationCitation(
      claim('NCD 220.6.17 "Glucose monitors for home use only"'), fakeFetch(recorded).opts);
    expect(mixed?.status).toBe('mixed');
    const unfinished = JSON.parse(fixture('ncd-220.6.17.json')) as { meta: { next_token: string } };
    unfinished.meta.next_token = 'more';
    const { opts } = fakeFetch({ [NCD_REPORT_URL]: () => jsonResponse(200, JSON.stringify(unfinished)) });
    expect(await checkRegulationCitation(claim('NCD 999.9.9'), opts)).toBeNull();
  });

  it('an LCD is looked up with the license token in the Authorization header and not in the URL', async () => {
    const { opts, calls } = fakeFetch(recorded);
    const result = await checkRegulationCitation(claim('LCD L33797'), opts);
    expect(result?.status).toBe('supported');
    expect(result?.explanation).toContain('Oxygen and Oxygen Equipment');
    expect(result?.sources[0]!.uri).toBe(LCD_33797);
    expect(calls.map((c) => c.url)).toEqual([LCD_LICENSE_URL, LCD_33797]);
    expect(headersOf(calls[0]!)).toEqual({ 'user-agent': REGULATION_USER_AGENT });
    expect(headersOf(calls[1]!)).toEqual({
      'user-agent': REGULATION_USER_AGENT,
      authorization: 'Bearer 00000000-0000-4000-8000-000000000001',
    });
    expect(calls.every((c) => !c.url.includes('00000000') && c.init.body === undefined)).toBe(true);
  });

  it('an LCD the database does not have is contradicted; a refused token is not a verdict', async () => {
    const missingLcd = fixture('lcd-not-found.json');
    const { opts, calls } = fakeFetch({
      ...recorded,
      [lcdDocumentUrl('999999')]: () => jsonResponse(200, missingLcd),
    });
    const result = await checkRegulationCitation(claim('LCD L999999'), opts);
    expect(result?.status).toBe('contradicted');
    expect(result?.sources[0]!.uri).toBe(lcdDocumentUrl('999999'));
    expect(calls).toHaveLength(2);

    const refused = fakeFetch({
      [LCD_LICENSE_URL]: recorded[LCD_LICENSE_URL]!,
      [LCD_33797]: () => jsonResponse(401, '{"meta":{"status":{"id":401,"message":"UNAUTHORIZED"},"notes":""},"data":[]}'),
    });
    expect(await checkRegulationCitation(claim('LCD L33797'), refused.opts)).toBeNull();

    const badToken = fakeFetch({
      [LCD_LICENSE_URL]: () => jsonResponse(200, JSON.stringify({ meta: { status: { id: 200 }, notes: '' }, data: [{ Token: 'not-a-uuid\r\nX: y' }] })),
    });
    expect(await checkRegulationCitation(claim('LCD L33797'), badToken.opts)).toBeNull();
    expect(badToken.calls).toHaveLength(1);
  });

  it('a claim with no regulation citation, or too many of them, is not looked up', async () => {
    const { opts, calls } = fakeFetch(recorded);
    expect(await checkRegulationCitation(claim('The work "Deep learning", DOI 10.1038/nature14539 exists as cited.'), opts)).toBeNull();
    expect(await checkRegulationCitation(claim('The LCD screen is 27 inches across the desk.'), opts)).toBeNull();
    const many = ['1.1', '1.2', '1.3', '1.4', '1.5'].map((id) => `NCD ${id}`).join(' ');
    expect(await checkRegulationCitation(claim(many), opts)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is off for `false` and for FAULTLINE_REGULATION_CHECK=off', () => {
    expect(resolveRegulationCheck(false)).toBeNull();
    vi.stubEnv('FAULTLINE_REGULATION_CHECK', 'OFF');
    expect(resolveRegulationCheck({ fetch: async () => new Response('') })).toBeNull();
    vi.unstubAllEnvs();
    expect(resolveRegulationCheck({ fetch: fetch })).toMatchObject({ fetch });
  });
});

describe('verify runner: a regulation citation settles before the normal verify, and a DOI citation does not change', () => {
  const searched: Source = { title: 'A page', uri: 'https://example.org/page' };

  function harness() {
    const regulationCalls: string[] = [];
    const regulation: RegulationCheckOptions = {
      fetch: async (url, init) => {
        regulationCalls.push(url);
        const route = recorded[url];
        if (!route) throw new Error(`unexpected ${url}`);
        return route();
      },
    };
    const doiCalls: string[] = [];
    const doi: DoiCheckOptions = {
      fetch: async (url) => {
        doiCalls.push(url);
        if (url === doiHandleUrl('10.4471/jca.2021.0388')) {
          return jsonResponse(404, JSON.stringify({ responseCode: 100 }));
        }
        throw new Error(`unexpected doi ${url}`);
      },
    };
    const retrieve = vi.fn(async (): Promise<Source[]> => [searched]);
    const provider = getProvider('', 'mock');
    const verifier: Verifier = {
      provider,
      providerName: 'mock',
      consensusRig: null,
      groundedRig: { retriever: { name: 'fake-search', retrieve } as unknown as Retriever },
    };
    const evidenceFetch = vi.fn(async () => new Response('', { status: 404 }));
    return { regulation, regulationCalls, doi, doiCalls, retrieve, verifier, evidenceFetch };
  }

  afterEach(() => { vi.unstubAllEnvs(); });

  it('a missing section is contradicted with no search and no page fetch', async () => {
    const h = harness();
    const run = await runVerification([claim('42 CFR 422.9999', 'missing')], h.verifier, {
      regulation: h.regulation, doi: h.doi, evidence: { fetch: h.evidenceFetch as never },
    });
    expect(run.verifications.missing?.status).toBe('contradicted');
    expect(run.verifications.missing?.provenance?.retriever).toBe(REGULATION_RETRIEVER);
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(h.doiCalls).toHaveLength(0);
    const fetched = h.evidenceFetch.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(fetched.every((url) => !url.includes('ecfr.gov') && !url.includes('coverage.cms.gov'))).toBe(true);
  });

  it('a real citation that the claim goes beyond falls through to one search', async () => {
    const h = harness();
    const text = '42 CFR 422.101(c) requires plans to cover every emergency service.';
    const run = await runVerification([claim(text, 'more')], h.verifier, { regulation: h.regulation, doi: false });
    expect(run.verifications.more?.provenance?.retriever).toBe('fake-search');
    expect(h.retrieve).toHaveBeenCalledTimes(1);
    expect(h.regulationCalls).toEqual([VERSIONS_422, XML_422]);
  });

  it('a failed lookup falls through, and the switch off skips the lookup', async () => {
    const h = harness();
    h.regulation.fetch = async () => { throw new Error('down'); };
    const run = await runVerification([claim('NCD 220.6.17', 'down')], h.verifier, { regulation: h.regulation, doi: false });
    expect(h.retrieve).toHaveBeenCalledTimes(1);
    expect(run.verifications.down?.provenance?.retriever).toBe('fake-search');

    const off = harness();
    vi.stubEnv('FAULTLINE_REGULATION_CHECK', 'off');
    await runVerification([claim('42 CFR 422.9999', 'off')], off.verifier, { regulation: off.regulation, doi: false });
    expect(off.regulationCalls).toHaveLength(0);
    expect(off.retrieve).toHaveBeenCalledTimes(1);
  });

  it('a DOI citation is still settled by the DOI check, and a plain fact is not looked up', async () => {
    const h = harness();
    const doiClaim: Claim = {
      id: 'doi', text: 'The work "Synthetic benchmarks" exists as cited.', type: 'fact', importance: 3,
      citation: { title: 'Synthetic benchmarks for imaginary tasks', doi: '10.4471/jca.2021.0388' },
    };
    const run = await runVerification(
      [doiClaim, claim('Water boils at 100 C at sea level.', 'fact')],
      h.verifier,
      { regulation: h.regulation, doi: h.doi },
    );
    expect(run.verifications.doi?.status).toBe('contradicted');
    expect(run.verifications.doi?.provenance?.retriever).toBe(DOI_RETRIEVER);
    expect(h.regulationCalls).toHaveLength(0);
    expect(h.doiCalls).toEqual([doiHandleUrl('10.4471/jca.2021.0388')]);
    expect(h.retrieve).toHaveBeenCalledTimes(1);
    expect(h.retrieve).toHaveBeenCalledWith('Water boils at 100 C at sea level.');
  });
});
