/**
 * Plugin Marketplace Registry — in-memory store for published plugins.
 *
 * Supports publish (create-or-update), search (text + type + sort),
 * get-by-id, get-by-name, and download-count increment.
 */

import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PluginType = 'rule' | 'provider' | 'both';

export interface PluginListing {
  id:            string;
  name:          string;        // npm package name
  version:       string;        // semver
  description:   string;
  author:        string;        // keyId of publisher
  type:          PluginType;
  keywords:      string[];
  downloadCount: number;
  publishedAt:   string;        // ISO
  updatedAt:     string;        // ISO
  repoUrl?:      string;
  readme?:       string;
}

export interface PublishInput {
  name:        string;
  version:     string;
  description: string;
  type:        PluginType;
  keywords?:   string[];
  repoUrl?:    string;
  readme?:     string;
}

export type SortOrder = 'downloads' | 'recent' | 'name';

export interface SearchParams {
  q?:       string;
  type?:    PluginType;
  sort?:    SortOrder;
  limit?:   number;
  offset?:  number;
}

export interface SearchResult {
  plugins:  PluginListing[];
  total:    number;
  limit:    number;
  offset:   number;
}

// ── Validation ────────────────────────────────────────────────────────────────

// npm package name (scoped or unscoped), simplified
const NPM_NAME_RE  = /^(?:@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*$/;
const SEMVER_RE    = /^\d+\.\d+\.\d+(?:[-+].+)?$/;
const URL_RE       = /^https?:\/\/.+/;
const PLUGIN_TYPES = new Set<string>(['rule', 'provider', 'both']);

export interface ValidationError {
  field:   string;
  message: string;
}

export function validatePublishInput(input: PublishInput): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!input.name || !NPM_NAME_RE.test(input.name)) {
    errors.push({ field: 'name', message: 'name must be a valid npm package name (lowercase, no spaces)' });
  }
  if (input.name && input.name.length > 214) {
    errors.push({ field: 'name', message: 'name must be ≤ 214 characters' });
  }
  if (!input.version || !SEMVER_RE.test(input.version)) {
    errors.push({ field: 'version', message: 'version must be a valid semver string (e.g. 1.0.0)' });
  }
  if (!input.description || input.description.length < 10) {
    errors.push({ field: 'description', message: 'description must be at least 10 characters' });
  }
  if (input.description && input.description.length > 500) {
    errors.push({ field: 'description', message: 'description must be ≤ 500 characters' });
  }
  if (!input.type || !PLUGIN_TYPES.has(input.type)) {
    errors.push({ field: 'type', message: 'type must be "rule", "provider", or "both"' });
  }
  if (input.keywords && input.keywords.length > 5) {
    errors.push({ field: 'keywords', message: 'keywords must have ≤ 5 items' });
  }
  if (input.repoUrl && !URL_RE.test(input.repoUrl)) {
    errors.push({ field: 'repoUrl', message: 'repoUrl must be a valid http/https URL' });
  }
  if (input.readme && input.readme.length > 10_000) {
    errors.push({ field: 'readme', message: 'readme must be ≤ 10,000 characters' });
  }

  return errors;
}

// ── Store ─────────────────────────────────────────────────────────────────────

class PluginRegistryStore {
  private listings: Map<string, PluginListing> = new Map(); // id → listing
  private byName:   Map<string, string>         = new Map(); // name → id

  /**
   * Publish a plugin.
   * - Same name + same author → update (upsert)
   * - Same name + different author → returns 'conflict'
   * - New name → insert
   */
  publish(input: PublishInput, author: string): { listing: PluginListing; created: boolean } | { conflict: true; existingAuthor: string } {
    const now = new Date().toISOString();
    const existing = this.byName.get(input.name);

    if (existing) {
      const prev = this.listings.get(existing)!;
      if (prev.author !== author) {
        return { conflict: true, existingAuthor: prev.author };
      }
      // Update
      const updated: PluginListing = {
        ...prev,
        version:     input.version,
        description: input.description,
        type:        input.type,
        keywords:    input.keywords ?? [],
        repoUrl:     input.repoUrl,
        readme:      input.readme,
        updatedAt:   now,
      };
      this.listings.set(updated.id, updated);
      return { listing: updated, created: false };
    }

    // Insert
    const listing: PluginListing = {
      id:            randomUUID(),
      name:          input.name,
      version:       input.version,
      description:   input.description,
      author,
      type:          input.type,
      keywords:      input.keywords ?? [],
      downloadCount: 0,
      publishedAt:   now,
      updatedAt:     now,
      repoUrl:       input.repoUrl,
      readme:        input.readme,
    };
    this.listings.set(listing.id, listing);
    this.byName.set(listing.name, listing.id);
    return { listing, created: true };
  }

  search(params: SearchParams): SearchResult {
    const limit  = Math.min(params.limit ?? 20, 50);
    const offset = params.offset ?? 0;
    const q      = params.q?.toLowerCase();

    let results = Array.from(this.listings.values());

    if (q) {
      results = results.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.keywords.some(k => k.toLowerCase().includes(q)),
      );
    }

    if (params.type) {
      results = results.filter(p => p.type === params.type || p.type === 'both');
    }

    const sort = params.sort ?? 'downloads';
    if (sort === 'downloads') {
      results.sort((a, b) => b.downloadCount - a.downloadCount);
    } else if (sort === 'recent') {
      results.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    } else {
      results.sort((a, b) => a.name.localeCompare(b.name));
    }

    return {
      plugins: results.slice(offset, offset + limit),
      total:   results.length,
      limit,
      offset,
    };
  }

  getById(id: string): PluginListing | undefined {
    return this.listings.get(id);
  }

  getByName(name: string): PluginListing | undefined {
    const id = this.byName.get(name);
    return id ? this.listings.get(id) : undefined;
  }

  incrementDownloads(id: string): void {
    const p = this.listings.get(id);
    if (p) p.downloadCount++;
  }

  get size(): number {
    return this.listings.size;
  }

  reset(): void {
    this.listings.clear();
    this.byName.clear();
  }
}

let instance: PluginRegistryStore | null = null;

export function getPluginRegistry(): PluginRegistryStore {
  if (!instance) instance = new PluginRegistryStore();
  return instance;
}

export function resetPluginRegistry(): void {
  instance = new PluginRegistryStore();
}
