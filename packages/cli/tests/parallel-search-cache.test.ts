// Validates: GoPMO 1.18.11.7.127 (judge model A/B pre-registration section 4: shared sources,
// later arms make no Parallel call; the cache is off in production).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CachedParallelSearchRetriever,
  RetrievalCacheMiss,
  isCacheableReply,
  parallelRetrieverFromEnv,
  retrievalCacheFromEnv,
} from '../providers/parallel_search_cache';
import { ParallelSearchRetriever } from '../providers/parallel_search_retriever';

const PAYLOAD = { search_id: 's1', results: [{ url: 'https://example.org/a', title: 'A', excerpts: ['alpha'] }] };

let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parallel-cache-'));
  fetchMock = vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('retrievalCacheFromEnv', () => {
  it('is off when the directory is unset or empty', () => {
    expect(retrievalCacheFromEnv({})).toBeNull();
    expect(retrievalCacheFromEnv({ FAULTLINE_RETRIEVAL_CACHE_DIR: '  ' })).toBeNull();
  });

  it('is off in production even when a directory is set', () => {
    expect(retrievalCacheFromEnv({ NODE_ENV: 'production', FAULTLINE_RETRIEVAL_CACHE_DIR: dir })).toBeNull();
    expect(retrievalCacheFromEnv({ NODE_ENV: ' Production ', FAULTLINE_RETRIEVAL_CACHE_DIR: dir })).toBeNull();
  });

  it('defaults to write mode; read only when asked', () => {
    expect(retrievalCacheFromEnv({ FAULTLINE_RETRIEVAL_CACHE_DIR: dir })).toEqual({ dir, mode: 'write' });
    expect(retrievalCacheFromEnv({ FAULTLINE_RETRIEVAL_CACHE_DIR: dir, FAULTLINE_RETRIEVAL_CACHE_MODE: 'READ' })).toEqual({ dir, mode: 'read' });
    expect(retrievalCacheFromEnv({ FAULTLINE_RETRIEVAL_CACHE_DIR: dir, FAULTLINE_RETRIEVAL_CACHE_MODE: 'other' })).toEqual({ dir, mode: 'write' });
  });
});

describe('parallelRetrieverFromEnv', () => {
  it('returns the plain retriever when the cache is off, and the cached one when it is on', () => {
    const plain = parallelRetrieverFromEnv('k', {}, {});
    expect(plain).toBeInstanceOf(ParallelSearchRetriever);
    expect(plain).not.toBeInstanceOf(CachedParallelSearchRetriever);
    expect(parallelRetrieverFromEnv('k', {}, { NODE_ENV: 'production', FAULTLINE_RETRIEVAL_CACHE_DIR: dir })).not.toBeInstanceOf(CachedParallelSearchRetriever);
    expect(parallelRetrieverFromEnv('k', {}, { FAULTLINE_RETRIEVAL_CACHE_DIR: dir })).toBeInstanceOf(CachedParallelSearchRetriever);
  });
});

describe('CachedParallelSearchRetriever', () => {
  it('write mode: searches once per claim, stores the reply 0600, and reuses it with no second call', async () => {
    const writer = new CachedParallelSearchRetriever('k', { dir, mode: 'write' });
    const first = await writer.retrieve('The Eiffel Tower is in Paris.');
    expect(first.map((s) => s.uri)).toEqual(['https://example.org/a']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(statSync(join(dir, files[0])).mode & 0o777).toBe(0o600);
    const again = await writer.retrieve('The Eiffel Tower is in Paris.');
    expect(again).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('read mode: a later arm gets the same sources with zero Parallel calls', async () => {
    await new CachedParallelSearchRetriever('k', { dir, mode: 'write' }).retrieve('Claim one.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reader = new CachedParallelSearchRetriever('k', { dir, mode: 'read' });
    const outcome = await reader.retrieveWithStatus('Claim one.');
    expect(outcome.status).toBe('hits');
    expect(outcome.sources.map((s) => s.uri)).toEqual(['https://example.org/a']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('read mode: a miss fails the search and never calls Parallel', async () => {
    const reader = new CachedParallelSearchRetriever('k', { dir, mode: 'read' });
    await expect(reader.callAPI('Never searched.')).rejects.toBeInstanceOf(RetrievalCacheMiss);
    await expect(reader.retrieve('Never searched.')).rejects.toThrow();
    const outcome = await reader.retrieveWithStatus('Never searched.');
    expect(outcome.status).toBe('provider_error');
    expect(outcome.sources).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keys by search mode as well as claim text', async () => {
    await new CachedParallelSearchRetriever('k', { dir, mode: 'write' }, { mode: 'advanced' }).retrieve('Same claim.');
    const fastReader = new CachedParallelSearchRetriever('k', { dir, mode: 'read' }, { mode: 'fast' });
    expect((await fastReader.retrieveWithStatus('Same claim.')).status).toBe('provider_error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('two requests for one uncached claim make one search and see the same reply', async () => {
    const writer = new CachedParallelSearchRetriever('k', { dir, mode: 'write' });
    const [a, b] = await Promise.all([writer.callAPI('Same time.'), writer.callAPI('Same time.')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('a 200 reply with no usable source is not cached, so a retry searches again', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ search_id: 'e', results: [] }), { status: 200 }));
    const writer = new CachedParallelSearchRetriever('k', { dir, mode: 'write' });
    await expect(writer.retrieve('Empty first.')).rejects.toThrow();
    expect(readdirSync(dir)).toHaveLength(0);
    expect((await writer.retrieve('Empty first.')).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('isCacheableReply accepts only a reply with a well-formed, usable result', () => {
    expect(isCacheableReply(PAYLOAD)).toBe(true);
    expect(isCacheableReply({})).toBe(false);
    expect(isCacheableReply({ results: [] })).toBe(false);
    expect(isCacheableReply({ results: [{ url: 'ftp://x.example/a' }] })).toBe(false);
    expect(isCacheableReply({ results: [{ url: 'https://example.org/a' }, { url: 7 }] })).toBe(false);
    expect(isCacheableReply(null)).toBe(false);
  });

  it('a failed search is not cached', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500, statusText: 'Server Error' }));
    const writer = new CachedParallelSearchRetriever('k', { dir, mode: 'write' });
    await expect(writer.retrieve('Flaky.')).rejects.toThrow();
    expect(readdirSync(dir)).toHaveLength(0);
    await writer.retrieve('Flaky.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
