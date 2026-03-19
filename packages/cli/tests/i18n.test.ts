import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { t, tLang, setLang, parseLang } from '../lib/i18n.js';

// Reset to English after every test so singleton state doesn't bleed between cases.
afterEach(() => {
  setLang('en');
});

describe('t() — English defaults', () => {
  it('t("report.header") returns a non-empty string (Gate 2)', () => {
    const result = t('report.header');
    expect(result.length).toBeGreaterThan(0);
  });

  it('t("report.header") equals the expected English string exactly', () => {
    expect(t('report.header')).toBe('=== FAULTLINE COMPLIANCE REPORT ===');
  });

  it('t("scan.verifying", { n: 3, total: 8 }) contains both interpolated values', () => {
    const result = t('scan.verifying', { n: 3, total: 8 });
    expect(result).toContain('3');
    expect(result).toContain('8');
  });

  it('t() with missing vars leaves placeholder as-is and does not crash', () => {
    // "err.file_not_found" has {{path}} — calling without vars should leave it
    const result = t('err.file_not_found');
    expect(result).toContain('{{path}}');
  });

  it('t("err.file_not_found", { path: "/tmp/test.txt" }) contains the interpolated path', () => {
    const result = t('err.file_not_found', { path: '/tmp/test.txt' });
    expect(result).toContain('/tmp/test.txt');
  });

  it('t("api.err.template_not_found") equals the exact English string', () => {
    expect(t('api.err.template_not_found')).toBe('Template not found.');
  });
});

describe('setLang() — language switching', () => {
  it('setLang("es") → t("report.header") returns a non-empty string (Gate 2, stub works)', () => {
    setLang('es');
    expect(t('report.header').length).toBeGreaterThan(0);
  });

  it('setLang("fr") → t("report.header") returns a non-empty string (Gate 2, stub works)', () => {
    setLang('fr');
    expect(t('report.header').length).toBeGreaterThan(0);
  });

  it('setLang("xx") falls back to "en" — no throw, non-empty output (Gate 2)', () => {
    setLang('xx');
    const result = t('report.header');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe('=== FAULTLINE COMPLIANCE REPORT ===');
  });

  it('afterEach resets lang — subsequent call uses English again', () => {
    setLang('es');
    // afterEach will reset; this test just documents the contract.
    // The next test in any describe block should see English.
    expect(t('report.end').length).toBeGreaterThan(0);
  });
});

describe('parseLang()', () => {
  it('parseLang("es-ES,es;q=0.9,en;q=0.8") returns "es"', () => {
    expect(parseLang('es-ES,es;q=0.9,en;q=0.8')).toBe('es');
  });

  it('parseLang("fr") returns "fr"', () => {
    expect(parseLang('fr')).toBe('fr');
  });

  it('parseLang("en-US") returns "en"', () => {
    expect(parseLang('en-US')).toBe('en');
  });

  it('parseLang("de") returns "en" — unsupported language falls back', () => {
    expect(parseLang('de')).toBe('en');
  });

  it('parseLang(undefined) returns "en"', () => {
    expect(parseLang(undefined)).toBe('en');
  });

  it('parseLang("") returns "en"', () => {
    expect(parseLang('')).toBe('en');
  });
});

describe('tLang() — stateless per-language translation', () => {
  it('tLang("api.err.unauthorized", "es") returns a non-empty string (Gate 2)', () => {
    expect(tLang('api.err.unauthorized', 'es').length).toBeGreaterThan(0);
  });

  it('tLang("api.err.unauthorized", "fr") returns a non-empty string (Gate 2)', () => {
    expect(tLang('api.err.unauthorized', 'fr').length).toBeGreaterThan(0);
  });

  it('tLang("api.err.unsupported_mime", "en", { mime, supported }) contains the mime type', () => {
    const result = tLang('api.err.unsupported_mime', 'en', {
      mime: 'video/mp4',
      supported: 'pdf, png',
    });
    expect(result).toContain('video/mp4');
  });

  it('tLang does not mutate the module-level singleton language', () => {
    // Module is reset to 'en' by afterEach, but tLang should never change it.
    tLang('report.header', 'es');
    // If singleton were mutated we'd get 'es' output; English string is the proof.
    expect(t('report.header')).toBe('=== FAULTLINE COMPLIANCE REPORT ===');
  });
});

describe('All "en" message keys produce non-empty strings (Gate 2)', () => {
  it('every key in the English catalogue resolves to a non-empty string', () => {
    // Collect all keys via tLang with 'en' and a sentinel that exercises the full catalogue.
    const keys: Array<Parameters<typeof tLang>[0]> = [
      'err.no_input',
      'err.file_not_found',
      'err.dir_not_found',
      'err.file_empty',
      'err.no_api_key',
      'err.unknown_command',
      'err.unknown_subcommand',
      'err.unknown_category',
      'err.template_not_found_local',
      'err.no_before_after',
      'err.fail_on_triggered',
      'api.err.no_key_configured',
      'api.err.unauthorized',
      'api.err.forbidden',
      'api.err.providers_unavailable',
      'api.err.template_not_found',
      'api.err.rate_limit',
      'api.err.no_file',
      'api.err.file_too_large',
      'api.err.unsupported_mime',
      'api.err.extracted_empty',
      'report.header',
      'report.end',
      'report.label.provider',
      'report.label.overall_risk',
      'report.label.eu_risk_tier',
      'report.label.generated',
      'report.section.eu_summary',
      'report.section.confidence',
      'report.section.verifications',
      'report.section.articles',
      'report.section.mitigations',
      'report.section.rule_findings',
      'scan.extracting',
      'scan.verifying',
      'scan.generating',
      'weakest.title',
      'weakest.top_n',
      'weakest.no_claims',
      'weakest.summary',
      'critique.title',
      'critique.no_failures',
      'critique.section.critique',
      'critique.section.improved_prompt',
      'rules.header',
      'init.created',
      'watch.started',
    ];

    // Gate 2: assert count is non-zero before iterating
    expect(keys.length).toBeGreaterThan(0);

    for (const key of keys) {
      const result = tLang(key, 'en');
      expect(result.length, `key "${key}" must produce a non-empty string`).toBeGreaterThan(0);
    }
  });
});
