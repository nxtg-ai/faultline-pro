/**
 * Changelog generator — parses git history between semver tags and produces
 * structured VersionBlock[] suitable for rendering as HTML or Markdown.
 *
 * Uses conventional-commits prefixes:
 *   feat | fix | docs | chore | refactor | perf | test | ci | build | cos
 * Lines starting with "BREAKING CHANGE:" in the commit body mark breaking changes.
 */

import { execSync } from 'node:child_process';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChangeEntry {
  hash:     string;
  subject:  string;
  type:     string;
  scope:    string | undefined;
  summary:  string;   // subject minus the "type(scope): " prefix
  breaking: boolean;
}

export interface VersionBlock {
  version:  string;
  tag:      string;
  date:     string;   // ISO date YYYY-MM-DD
  features: ChangeEntry[];
  fixes:    ChangeEntry[];
  breaking: ChangeEntry[];
  other:    ChangeEntry[];
}

// ── Parsing ───────────────────────────────────────────────────────────────────

const CONV_RE = /^(?<type>feat|fix|docs|chore|refactor|perf|test|ci|build|cos|style|revert)(?:\((?<scope>[^)]+)\))?(?<bang>!)?: (?<summary>.+)$/i;

export function parseConventionalCommit(hash: string, subject: string): ChangeEntry {
  const m = CONV_RE.exec(subject);
  if (!m?.groups) {
    return { hash, subject, type: 'other', scope: undefined, summary: subject, breaking: false };
  }
  return {
    hash,
    subject,
    type:    m.groups['type']!.toLowerCase(),
    scope:   m.groups['scope'] || undefined,
    summary: m.groups['summary']!,
    breaking: m.groups['bang'] === '!',
  };
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function listTags(cwd: string): { tag: string; date: string; hash: string }[] {
  // Use two calls to avoid shell-escaping issues with %(refname:short) parens
  const names = run('git tag --sort=version:refname', cwd);
  if (!names) return [];
  return names.split('\n').filter(Boolean).map(tag => {
    const date = run(`git log -1 --format=%ci "${tag}"`, cwd).slice(0, 10);
    const hash = run(`git rev-parse --short "${tag}"`, cwd);
    return { tag, date, hash };
  });
}

function commitsInRange(range: string, cwd: string): { hash: string; subject: string }[] {
  // Use %x09 (tab) as delimiter — safe from shell pipe parsing and rarely in subjects
  const raw = run(`git log ${range} --pretty=format:"%h%x09%s" --no-merges`, cwd);
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const idx = line.indexOf('\t');
    if (idx === -1) return { hash: line.trim(), subject: '' };
    return { hash: line.slice(0, idx).trim(), subject: line.slice(idx + 1).trim() };
  });
}

// ── Changelog builder ─────────────────────────────────────────────────────────

export function buildChangelog(repoRoot: string): VersionBlock[] {
  const tags = listTags(repoRoot);
  if (tags.length === 0) return [];

  const blocks: VersionBlock[] = [];

  // Unreleased: HEAD → latest tag
  const latestTag = tags[tags.length - 1]!;
  const unreleasedCommits = commitsInRange(`${latestTag.tag}..HEAD`, repoRoot);
  if (unreleasedCommits.length > 0) {
    blocks.push(classify('Unreleased', 'HEAD', new Date().toISOString().slice(0, 10), unreleasedCommits));
  }

  // Tagged versions: newest first
  for (let i = tags.length - 1; i >= 0; i--) {
    const curr = tags[i]!;
    const prev = i > 0 ? tags[i - 1]! : null;
    const range = prev ? `${prev.tag}..${curr.tag}` : curr.tag;
    const commits = commitsInRange(range, repoRoot);
    blocks.push(classify(curr.tag, curr.tag, curr.date, commits));
  }

  return blocks;
}

function classify(
  version: string,
  tag:     string,
  date:    string,
  commits: { hash: string; subject: string }[],
): VersionBlock {
  const entries = commits.map(c => parseConventionalCommit(c.hash, c.subject));
  return {
    version,
    tag,
    date,
    features: entries.filter(e => e.type === 'feat'),
    fixes:    entries.filter(e => e.type === 'fix'),
    breaking: entries.filter(e => e.breaking),
    other:    entries.filter(e => !['feat', 'fix'].includes(e.type) && !e.breaking),
  };
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

export function toMarkdown(blocks: VersionBlock[]): string {
  const lines: string[] = [
    '# Changelog',
    '',
    'All notable changes to Faultline Pro are documented here.',
    'Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).',
    '',
  ];

  for (const b of blocks) {
    lines.push(`## [${b.version}] — ${b.date}`, '');

    if (b.breaking.length > 0) {
      lines.push('### ⚠ Breaking Changes', '');
      b.breaking.forEach(e => lines.push(`- ${e.summary}`));
      lines.push('');
    }
    if (b.features.length > 0) {
      lines.push('### Added', '');
      b.features.forEach(e => lines.push(`- ${e.summary}`));
      lines.push('');
    }
    if (b.fixes.length > 0) {
      lines.push('### Fixed', '');
      b.fixes.forEach(e => lines.push(`- ${e.summary}`));
      lines.push('');
    }
    if (b.other.length > 0) {
      lines.push('### Changed', '');
      b.other.forEach(e => lines.push(`- ${e.summary}`));
      lines.push('');
    }

    if (b.breaking.length === 0 && b.features.length === 0 && b.fixes.length === 0 && b.other.length === 0) {
      lines.push('_No recorded changes._', '');
    }
  }

  return lines.join('\n');
}
