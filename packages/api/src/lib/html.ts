/**
 * Shared HTML utility — N-112
 *
 * Centralises HTML entity encoding for all server-side HTML builders.
 * Prevents XSS by ensuring user-controlled content is consistently escaped
 * before being interpolated into HTML template strings.
 */

/**
 * Encodes the four HTML metacharacters: & < > "
 * Call this on every string interpolated into an HTML template.
 */
export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Alias for {@link esc} — matches the name used in older route files. */
export const escHtml: (s: unknown) => string = esc;
