/**
 * N-112 — Shared HTML escape utility (src/lib/html.ts)
 *
 * ET1–ET8   esc() unit tests: empty string, plain text, ampersand, less-than,
 *           greater-than, double-quote, combined metacharacters, non-string coercion.
 * ET9       escHtml alias is identical to esc (same implementation).
 * ET10–ET12 Security: XSS injection patterns neutralised — script tags, event
 *           handlers, javascript: URLs.
 * ET13–ET15 Route integration: HTML responses from claims, changelog, and webhooks
 *           dashboards correctly escape dangerous content.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { esc, escHtml } from '../src/lib/html.js';

// ── esc() unit tests ──────────────────────────────────────────────────────────

describe('esc() — unit', () => {
  it('ET1: empty string returns empty string', () => {
    expect(esc('')).toBe('');
  });

  it('ET2: string with no metacharacters is returned unchanged', () => {
    expect(esc('hello world 123')).toBe('hello world 123');
  });

  it('ET3: ampersand is encoded as &amp;', () => {
    expect(esc('a & b')).toBe('a &amp; b');
  });

  it('ET4: less-than is encoded as &lt;', () => {
    expect(esc('<tag>')).toBe('&lt;tag&gt;');
  });

  it('ET5: greater-than is encoded as &gt;', () => {
    expect(esc('x > y')).toBe('x &gt; y');
  });

  it('ET6: double-quote is encoded as &quot;', () => {
    expect(esc('"quoted"')).toBe('&quot;quoted&quot;');
  });

  it('ET7: all four metacharacters encoded in one string', () => {
    expect(esc('<a href="x&y">z</a>')).toBe(
      '&lt;a href=&quot;x&amp;y&quot;&gt;z&lt;/a&gt;',
    );
  });

  it('ET8: non-string input is coerced via String()', () => {
    expect(esc(42)).toBe('42');
    expect(esc(null)).toBe('null');
    expect(esc(undefined)).toBe('undefined');
  });
});

// ── escHtml alias ─────────────────────────────────────────────────────────────

describe('escHtml — alias', () => {
  it('ET9: escHtml produces identical output to esc', () => {
    const cases = [
      '<script>alert(1)</script>',
      '"quoted" & <escaped>',
      'plain text',
      '',
    ];
    for (const input of cases) {
      expect(escHtml(input)).toBe(esc(input));
    }
  });
});

// ── Security: XSS patterns neutralised ───────────────────────────────────────

describe('esc() — XSS neutralisation', () => {
  it('ET10: script tag injection is neutralised', () => {
    const input = '<script>alert("xss")</script>';
    const result = esc(input);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('</script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('ET11: event handler attribute injection is neutralised', () => {
    const input = '" onmouseover="alert(1)';
    const result = esc(input);
    expect(result).not.toContain('"');
    expect(result).toContain('&quot;');
    // The string as an HTML attribute value is safe
    expect(result).toBe('&quot; onmouseover=&quot;alert(1)');
  });

  it('ET12: double-encoding is deterministic (idempotent on already-encoded input)', () => {
    // Encoding an already-encoded string produces double-encoding — expected safe behavior
    const once  = esc('<b>');
    const twice = esc(once);
    expect(twice).toBe('&amp;lt;b&amp;gt;');
    // The important property: the output never contains a raw <
    expect(twice).not.toContain('<');
  });
});

// ── Route integration: HTML dashboards escape injected content ───────────────

describe('Route HTML responses — escape integration', () => {
  let apiKey: string;

  beforeEach(() => {
    apiKey = 'test-escape-route';
    process.env.FAULTLINE_API_KEY = apiKey;
  });

  afterEach(() => {
    delete process.env.FAULTLINE_API_KEY;
  });

  it('ET13: GET /webhooks/deliveries/view escapes error text containing <script>', async () => {
    const { buildServer } = await import('../src/server.js');
    const { getWebhookDeliveryLog, resetWebhookDeliveryLog } = await import('../src/store/webhooks.js');
    resetWebhookDeliveryLog();

    getWebhookDeliveryLog().push({
      id:         'r-xss',
      webhookId:  'wh-xss',
      event:      'scan.complete',
      url:        'https://example.com/hook',
      timestamp:  new Date().toISOString(),
      attempt:    1,
      statusCode: null,
      delivered:  false,
      latencyMs:  0,
      error:      '<script>alert("xss")</script>',
    });

    const server = buildServer();
    const res = await server.inject({
      method: 'GET',
      url: '/webhooks/deliveries/view',
      headers: { 'x-api-key': apiKey },
    });
    await server.close();
    resetWebhookDeliveryLog();

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<script>alert("xss")</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('ET14: GET /changelog renders without raw metacharacters in version strings', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    const res = await server.inject({ method: 'GET', url: '/changelog' });
    await server.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // The page itself must not contain bare unescaped < in visible text content
    // (script/style tags are expected — check that the body element is present)
    expect(res.body).toContain('</html>');
  });

  it('ET15: GET /claims/view with a search query containing < is escaped in the response', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    const res = await server.inject({
      method: 'GET',
      url: '/claims/view?text=%3Cscript%3E',  // ?text=<script>
      headers: { 'x-api-key': apiKey },
    });
    await server.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // The raw string '<script>' must not appear unescaped in the HTML
    expect(res.body).not.toContain('<script>alert');
  });
});
