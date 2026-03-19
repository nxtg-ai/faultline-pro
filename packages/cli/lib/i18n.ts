/**
 * i18n module for Faultline CLI and API.
 *
 * CLI usage (stateful singleton):
 *   setLang('es');
 *   t('report.header');
 *
 * API usage (stateless, per-request):
 *   const lang = parseLang(request.headers['accept-language']);
 *   tLang('api.err.unauthorized', lang);
 *
 * NOTE: This file lives in packages/cli/lib/. Once the package.json "files"
 * field is updated to include "lib/", it will be published. Until then, import
 * via relative path from within the cli package.
 *
 * Spanish and French catalogues are populated with English strings as stubs.
 * Translators will replace the values; the catalogue structure is complete.
 */

export type Lang = 'en' | 'es' | 'fr';

const SUPPORTED_LANGS: readonly Lang[] = ['en', 'es', 'fr'];

function isSupportedLang(value: string): value is Lang {
  return (SUPPORTED_LANGS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Message catalogue
// ---------------------------------------------------------------------------

const messages = {
  en: {
    // CLI errors
    'err.no_input': 'No --input, --dir, --file, or --templates flag provided.',
    'err.file_not_found': 'Error: File not found: {{path}}',
    'err.dir_not_found': 'Error: Directory not found: {{path}}',
    'err.file_empty': 'Error: Input file is empty.',
    'err.no_api_key': 'No API key found for provider "{{provider}}".',
    'err.unknown_command': 'Unknown command: {{command}}',
    'err.unknown_subcommand':
      'Unknown {{cmd}} subcommand: {{sub}}. Usage: faultline {{cmd}} list',
    'err.unknown_category':
      'Error: Unknown category "{{category}}". Available: {{available}}',
    'err.template_not_found_local':
      'Error: Template "{{name}}" not found. Available: {{available}}',
    'err.no_before_after': 'Error: --before and --after are required for compare.',
    'err.fail_on_triggered':
      'Scan failed: risk level "{{risk}}" meets or exceeds fail-on threshold "{{threshold}}".',
    // API errors
    'api.err.no_key_configured': 'API key not configured on server.',
    'api.err.unauthorized': 'Unauthorized. Provide a valid x-api-key header.',
    'api.err.forbidden': 'Forbidden. Admin access required.',
    'api.err.providers_unavailable':
      'All providers are currently unavailable. Please retry later.',
    'api.err.template_not_found': 'Template not found.',
    'api.err.rate_limit': 'Rate limit exceeded.',
    'api.err.no_file': 'No file field in multipart request.',
    'api.err.file_too_large': 'File exceeds the 10MB limit.',
    'api.err.unsupported_mime':
      'Unsupported file type: {{mime}}. Supported: {{supported}}',
    'api.err.extracted_empty': 'Extracted text is empty.',
    // CLI report
    'report.header': '=== FAULTLINE COMPLIANCE REPORT ===',
    'report.end': '=== END REPORT ===',
    'report.label.provider': 'Provider:',
    'report.label.overall_risk': 'Overall Risk:',
    'report.label.eu_risk_tier': 'EU Risk Tier:',
    'report.label.generated': 'Generated:',
    'report.section.eu_summary': '--- EU AI Act Risk Summary ---',
    'report.section.confidence': '--- Confidence Distribution ---',
    'report.section.verifications': '--- Claim Verifications ---',
    'report.section.articles': '--- Triggered EU AI Act Articles ---',
    'report.section.mitigations': '--- Recommended Mitigations ---',
    'report.section.rule_findings': '--- Rule Findings ---',
    // CLI scan progress
    'scan.extracting': 'Extracting claims...',
    'scan.verifying': 'Verifying claim {{n}}/{{total}}...',
    'scan.generating': 'Generating report...',
    // CLI weakest-link
    'weakest.title': 'Weakest-Link Analysis',
    'weakest.top_n': 'Top {{n}} fragile claims:',
    'weakest.no_claims': 'No verified claims to analyze for weakest-link detection.',
    'weakest.summary': 'Summary: {{text}}',
    // CLI critique
    'critique.title': 'Critique Analysis',
    'critique.no_failures': 'No failed claims — all verified claims are supported.',
    'critique.section.critique': 'CRITIQUE:',
    'critique.section.improved_prompt': 'IMPROVED PROMPT:',
    // CLI misc
    'rules.header': 'Available rules:',
    'init.created': 'Created {{path}}',
    'watch.started': 'Watching {{dir}} for changes... (Ctrl+C to stop)',
  },
} as const;

// Spanish stubs: full catalogue, English strings — translators will update.
const esMessages: Record<MessageKey, string> = { ...messages.en };

// French stubs: full catalogue, English strings — translators will update.
const frMessages: Record<MessageKey, string> = { ...messages.en };

const catalogue: Record<Lang, Record<MessageKey, string>> = {
  en: messages.en as Record<MessageKey, string>,
  es: esMessages,
  fr: frMessages,
};

export type MessageKey = keyof typeof messages.en;

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Replace {{varName}} placeholders in a template string.
 * Missing variables leave the placeholder untouched — no crash, no empty string.
 */
function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = vars[key];
    return value !== undefined ? String(value) : match;
  });
}

// ---------------------------------------------------------------------------
// Module-level singleton (CLI)
// ---------------------------------------------------------------------------

let currentLang: Lang = 'en';

/**
 * Set the module-level language for CLI use.
 * Falls back to 'en' for any unrecognised value — never throws.
 */
export function setLang(lang: string): void {
  currentLang = isSupportedLang(lang) ? lang : 'en';
}

// ---------------------------------------------------------------------------
// Accept-Language parser (API)
// ---------------------------------------------------------------------------

/**
 * Parse an HTTP Accept-Language header into a supported Lang.
 * Returns 'en' for undefined, empty, or unrecognised values.
 *
 * Handles full quality-factor syntax:
 *   'es-ES,es;q=0.9,en;q=0.8' → 'es'
 *   'fr'                       → 'fr'
 *   'de'                       → 'en'  (unsupported, fallback)
 */
export function parseLang(acceptLanguage: string | undefined): Lang {
  if (!acceptLanguage) return 'en';

  // Split by comma, parse each tag and its q value, sort by q descending.
  const entries = acceptLanguage
    .split(',')
    .map((part) => {
      const [tagRaw, qPart] = part.trim().split(';');
      const tag = (tagRaw ?? '').trim().toLowerCase();
      const q = qPart ? parseFloat(qPart.replace(/^\s*q\s*=\s*/, '')) : 1.0;
      return { tag, q: Number.isNaN(q) ? 1.0 : q };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of entries) {
    // Exact match first: 'fr'
    if (isSupportedLang(tag)) return tag;
    // Primary language subtag: 'es-MX' → 'es'
    const primary = tag.split('-')[0] ?? '';
    if (isSupportedLang(primary)) return primary;
  }

  return 'en';
}

// ---------------------------------------------------------------------------
// Translation functions
// ---------------------------------------------------------------------------

/**
 * Translate a message key using the module-level language (CLI singleton).
 * Interpolates {{varName}} placeholders from vars.
 */
export function t(
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const template = catalogue[currentLang][key] ?? catalogue.en[key] ?? key;
  return interpolate(template, vars);
}

/**
 * Translate a message key for a specific language (API per-request).
 * Stateless — does not read or modify the module singleton.
 */
export function tLang(
  key: MessageKey,
  lang: Lang,
  vars?: Record<string, string | number>,
): string {
  const langCatalogue = catalogue[lang] ?? catalogue.en;
  const template = langCatalogue[key] ?? catalogue.en[key] ?? key;
  return interpolate(template, vars);
}
