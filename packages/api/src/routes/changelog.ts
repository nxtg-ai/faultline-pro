/**
 * GET /changelog      — Human-readable HTML changelog (auto-refreshes from git tags)
 * GET /changelog.json — Machine-readable JSON version of the same data
 */

import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildChangelog, toMarkdown } from '../lib/changelog.js';
import type { VersionBlock } from '../lib/changelog.js';

// Walk up from this file until we find the .git directory
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, '.git'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const __dir     = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = findRepoRoot(__dir);

// Build once at startup; cache for the process lifetime
let _cache: VersionBlock[] | null = null;

function getChangelog(): VersionBlock[] {
  if (!_cache) _cache = buildChangelog(REPO_ROOT);
  return _cache;
}

/** Exposed for tests to reset the cache between calls */
export function resetChangelogCache(): void {
  _cache = null;
}

// ── HTML template ─────────────────────────────────────────────────────────────

function renderHtml(blocks: VersionBlock[]): string {
  const versionHtml = blocks.map(b => {
    const hasBreaking = b.breaking.length > 0;
    const versionClass = b.version === 'Unreleased' ? 'unreleased' : 'released';

    const section = (title: string, icon: string, items: { summary: string; hash: string }[], cls: string) => {
      if (items.length === 0) return '';
      const lis = items.map(e =>
        `<li><span class="hash">${e.hash}</span>${escHtml(e.summary)}</li>`
      ).join('\n        ');
      return `
      <div class="group ${cls}">
        <h3>${icon} ${title}</h3>
        <ul>${lis}</ul>
      </div>`;
    };

    const empty = b.features.length === 0 && b.fixes.length === 0 && b.breaking.length === 0 && b.other.length === 0;

    return `
  <section class="version ${versionClass}${hasBreaking ? ' has-breaking' : ''}">
    <div class="version-header">
      <span class="version-badge ${versionClass}">${escHtml(b.version)}</span>
      <span class="version-date">${b.date}</span>
      ${hasBreaking ? '<span class="breaking-badge">⚠ Breaking</span>' : ''}
    </div>
    ${empty ? '<p class="no-changes">No recorded changes.</p>' : ''}
    ${section('Breaking Changes', '⚠', b.breaking, 'breaking')}
    ${section('Added', '✦', b.features, 'features')}
    ${section('Fixed', '⚑', b.fixes, 'fixes')}
    ${section('Changed', '↻', b.other, 'other')}
  </section>`;
  }).join('\n');

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Faultline Pro — Changelog</title>
<style>
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3a;--text:#e2e8f0;--muted:#718096;--green:#48bb78;--yellow:#ecc94b;--red:#fc8181;--blue:#63b3ed;--accent:#7c3aed;--accent-light:#a78bfa}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding-bottom:80px}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:24px 0}
.container{max-width:780px;margin:0 auto;padding:0 24px}
.header-inner{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}
.logo{font-size:20px;font-weight:700;letter-spacing:-0.5px}
.logo span{color:var(--accent)}
.header-sub{font-size:14px;color:var(--muted)}
.nav-links{margin-left:auto;display:flex;gap:16px;font-size:13px}
.timeline{margin-top:40px;position:relative;padding-left:24px}
.timeline::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--border)}
.version{position:relative;margin-bottom:40px}
.version::before{content:'';position:absolute;left:-29px;top:10px;width:12px;height:12px;border-radius:50%;background:var(--border);border:2px solid var(--bg)}
.version.unreleased::before{background:var(--accent);border-color:var(--bg);box-shadow:0 0 0 3px rgba(124,58,237,.2)}
.version.released::before{background:var(--green);border-color:var(--bg)}
.version.has-breaking::before{background:var(--yellow)}
.version-header{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.version-badge{padding:3px 10px;border-radius:6px;font-size:14px;font-weight:700;font-family:'SF Mono',Menlo,monospace}
.version-badge.unreleased{background:rgba(124,58,237,.2);color:var(--accent-light);border:1px solid rgba(124,58,237,.3)}
.version-badge.released{background:rgba(72,187,120,.12);color:var(--green);border:1px solid rgba(72,187,120,.2)}
.version-date{font-size:13px;color:var(--muted)}
.breaking-badge{background:rgba(236,201,75,.15);color:var(--yellow);border:1px solid rgba(236,201,75,.3);padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600}
.group{margin-bottom:16px}
.group h3{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.group.breaking h3{color:var(--yellow)}
.group.features h3{color:var(--accent-light)}
.group.fixes h3{color:var(--green)}
.group.other h3{color:var(--muted)}
.group ul{list-style:none;display:flex;flex-direction:column;gap:5px}
.group ul li{font-size:14px;line-height:1.5;display:flex;align-items:baseline;gap:8px;padding:5px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px}
.hash{font-family:'SF Mono',Menlo,monospace;font-size:11px;color:var(--muted);background:rgba(255,255,255,.05);padding:1px 5px;border-radius:3px;white-space:nowrap;flex-shrink:0}
.no-changes{font-size:13px;color:var(--muted);font-style:italic}
.footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--border);font-size:12px;color:var(--muted);display:flex;gap:16px}
</style>
</head>
<body>
<div class="header">
  <div class="container">
    <div class="header-inner">
      <span class="logo"><span>fault</span>line pro</span>
      <span class="header-sub">Changelog — all notable changes</span>
      <div class="nav-links">
        <a href="/status">Status</a>
        <a href="/docs">API Docs</a>
        <a href="/changelog.md">Markdown</a>
      </div>
    </div>
  </div>
</div>
<div class="container">
  <div class="timeline">
    ${versionHtml || '<p style="color:var(--muted);margin-top:24px">No tagged releases found.</p>'}
  </div>
  <div class="footer">
    <span>Faultline Pro v0.3.0</span>
    <a href="/changelog.json">JSON</a>
    <a href="https://keepachangelog.com">Keep a Changelog</a>
  </div>
</div>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function changelogRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/changelog', {
    schema: { tags: ['Monitoring'], summary: 'HTML changelog — auto-generated from git tags' },
  }, async (_req, reply) => {
    const blocks = getChangelog();
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return renderHtml(blocks);
  });

  fastify.get('/changelog.json', {
    schema: { tags: ['Monitoring'], summary: 'JSON changelog data' },
  }, async () => {
    return getChangelog();
  });

  fastify.get('/changelog.md', {
    schema: { tags: ['Monitoring'], summary: 'Markdown changelog' },
  }, async (_req, reply) => {
    const blocks = getChangelog();
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', 'inline; filename="CHANGELOG.md"');
    return toMarkdown(blocks);
  });
}
