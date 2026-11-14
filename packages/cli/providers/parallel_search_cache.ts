import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ParallelSearchRetriever, isWellFormedResult, parseParallelResults } from './parallel_search_retriever';

/**
 * A local, per-claim cache of Parallel search replies, for measurement runs only.
 *
 * The judge model A/B (docs/research/2026-11-14-prereg-judge-model-ab-v1.md,
 * section 4) holds retrieval fixed so that arms differ only in the judge. The
 * first arm searches and writes each reply here. The later arms, each on its own
 * local API process with a different judge model, read the same reply and make
 * no Parallel call.
 *
 * It is on only when FAULTLINE_RETRIEVAL_CACHE_DIR is set, and never when
 * NODE_ENV is production. Production sets neither the directory nor anything
 * else here, so every hosted search is a fresh call, as before.
 *
 * FAULTLINE_RETRIEVAL_CACHE_MODE:
 * - `write` (default): a cached reply is reused; a miss searches and stores the reply.
 * - `read`: a cached reply is reused; a miss fails the search (the claim reads as
 *   not checked). It never calls Parallel, so a later arm cannot search by accident.
 *
 * Files are named by a hash of the mode and the claim text, written 0600 in a
 * 0700 directory. The run's owner deletes the directory after scoring.
 */

export type RetrievalCacheMode = 'write' | 'read';

export interface RetrievalCacheConfig {
  dir: string;
  mode: RetrievalCacheMode;
}

/** The cache the environment asks for, or null: unset, empty, or in production. */
export function retrievalCacheFromEnv(env: NodeJS.ProcessEnv = process.env): RetrievalCacheConfig | null {
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') return null;
  const dir = (env.FAULTLINE_RETRIEVAL_CACHE_DIR ?? '').trim();
  if (dir === '') return null;
  const mode: RetrievalCacheMode = (env.FAULTLINE_RETRIEVAL_CACHE_MODE ?? '').trim().toLowerCase() === 'read' ? 'read' : 'write';
  return { dir, mode };
}

/** Thrown on a miss in read mode. The message is fixed and carries no claim text. */
export class RetrievalCacheMiss extends Error {
  constructor() {
    super('retrieval cache miss in read mode');
    this.name = 'RetrievalCacheMiss';
  }
}

type ParallelReply = Awaited<ReturnType<ParallelSearchRetriever['callAPI']>>;

/**
 * Only a reply the retriever would accept as hits is stored: an object with a results
 * list, every entry well formed, and at least one source a reader can open. Anything
 * else is returned to the caller (which reports it as it always did) and searched
 * again on a retry, never replayed from the cache.
 */
export function isCacheableReply(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results) || !results.every(isWellFormedResult)) return false;
  return parseParallelResults(payload as ParallelReply).length > 0;
}

/** Searches in flight, by cache file, across every retriever in this process. */
const inFlight = new Map<string, Promise<ParallelReply>>();

function readCached(file: string): ParallelReply | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ParallelReply;
  } catch {
    return null;
  }
}

export class CachedParallelSearchRetriever extends ParallelSearchRetriever {
  readonly cache: RetrievalCacheConfig;

  constructor(apiKey: string, cache: RetrievalCacheConfig, opts: { mode?: string; timeoutMs?: number } = {}) {
    super(apiKey, opts);
    this.cache = cache;
    mkdirSync(cache.dir, { recursive: true, mode: 0o700 });
  }

  /** The cache file for one claim in this search mode. */
  cacheFile(claimText: string): string {
    const key = createHash('sha256').update(`${this.mode}\n${claimText}`).digest('hex');
    return path.join(this.cache.dir, `${key}.json`);
  }

  override async callAPI(claimText: string): Promise<ParallelReply> {
    const file = this.cacheFile(claimText);
    // A cached reply is not a new search: no usage is recorded, so nothing is billed.
    const cached = readCached(file);
    if (cached !== null) return cached;
    if (this.cache.mode === 'read') throw new RetrievalCacheMiss();
    // A second request for the same claim waits for the first search instead of making its own,
    // so both judge the reply that is stored.
    const pending = inFlight.get(file);
    if (pending) return pending;
    const search = this.searchAndStore(claimText, file);
    inFlight.set(file, search);
    try {
      return await search;
    } finally {
      inFlight.delete(file);
    }
  }

  private async searchAndStore(claimText: string, file: string): Promise<ParallelReply> {
    const payload = await super.callAPI(claimText);
    if (!isCacheableReply(payload)) return payload;
    try {
      writeFileSync(file, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Another process stored this claim first: that reply is the shared one, so use it.
      const stored = readCached(file);
      if (stored !== null) return stored;
    }
    return payload;
  }
}

/** A Parallel retriever for this process: the cached one when the environment turns it on. */
export function parallelRetrieverFromEnv(
  apiKey: string,
  opts: { mode?: string; timeoutMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): ParallelSearchRetriever {
  const cache = retrievalCacheFromEnv(env);
  return cache ? new CachedParallelSearchRetriever(apiKey, cache, opts) : new ParallelSearchRetriever(apiKey, opts);
}
