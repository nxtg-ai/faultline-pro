import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global fetch for the Responses API call.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  OpenAIWebSearchRetriever,
  parseResponsesSources,
} from '../providers/openai_web_search_retriever';

/**
 * Shape mirrors the LIVE Responses-API payload observed 2026-06-21 against
 * gpt-4o + web_search: output[] holds a 'message' item whose output_text
 * content carries annotations[] of type 'url_citation' with start/end index.
 */
function makeResponse(text: string, annotations: Array<Record<string, unknown>>) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      output: [
        { type: 'web_search_call' },
        {
          type: 'message',
          content: [{ type: 'output_text', text, annotations }],
        },
      ],
    }),
  };
}

describe('OpenAIWebSearchRetriever', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.FAULTLINE_OPENAI_SEARCH_MODEL;
    delete process.env.FAULTLINE_DEBUG;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('parseResponsesSources', () => {
    const TEXT =
      'AAAABBBBCCCCDDDDEEEEFFFF the Eiffel Tower is in Paris per Britannica and Wikipedia.';

    it('maps each url_citation to a Source with a per-span snippet', () => {
      const sources = parseResponsesSources({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: TEXT,
                annotations: [
                  {
                    type: 'url_citation',
                    title: 'Britannica',
                    url: 'https://www.britannica.com/eiffel',
                    start_index: 0,
                    end_index: 4,
                  },
                  {
                    type: 'url_citation',
                    title: 'Wikipedia',
                    url: 'https://en.wikipedia.org/wiki/Eiffel_Tower',
                    start_index: 4,
                    end_index: 8,
                  },
                ],
              },
            ],
          },
        ],
      });

      expect(sources).toHaveLength(2);
      expect(sources[0]).toEqual({
        title: 'Britannica',
        uri: 'https://www.britannica.com/eiffel',
        snippet: 'AAAA',
      });
      expect(sources[1].uri).toBe('https://en.wikipedia.org/wiki/Eiffel_Tower');
      // PREFERRED per-source span, NOT the shared full text.
      expect(sources[1].snippet).toBe('BBBB');
    });

    it('falls back to full message text when indices are invalid', () => {
      const sources = parseResponsesSources({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: TEXT,
                annotations: [
                  {
                    type: 'url_citation',
                    title: 'NoIndex',
                    url: 'https://example.com/a',
                    // missing start/end → shared-snippet fallback
                  },
                ],
              },
            ],
          },
        ],
      });
      expect(sources).toHaveLength(1);
      expect(sources[0].snippet).toBe(TEXT);
    });

    it('de-duplicates repeated URLs and caps at maxResults', () => {
      const anns = [
        { type: 'url_citation', title: 'A', url: 'https://a.com', start_index: 0, end_index: 4 },
        { type: 'url_citation', title: 'A dup', url: 'https://a.com', start_index: 4, end_index: 8 },
        { type: 'url_citation', title: 'B', url: 'https://b.com', start_index: 8, end_index: 12 },
        { type: 'url_citation', title: 'C', url: 'https://c.com', start_index: 12, end_index: 16 },
      ];
      const sources = parseResponsesSources({
        output: [{ type: 'message', content: [{ type: 'output_text', text: TEXT, annotations: anns }] }],
      }, 2);
      expect(sources).toHaveLength(2);
      expect(sources.map((s) => s.uri)).toEqual(['https://a.com', 'https://b.com']);
    });

    it('ignores non-url_citation annotations', () => {
      const sources = parseResponsesSources({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: TEXT,
                annotations: [
                  { type: 'file_citation', title: 'doc', url: 'https://file.com' },
                  { type: 'url_citation', title: 'Real', url: 'https://real.com', start_index: 0, end_index: 4 },
                ],
              },
            ],
          },
        ],
      });
      expect(sources).toHaveLength(1);
      expect(sources[0].uri).toBe('https://real.com');
    });

    it('returns [] when there is no message item', () => {
      expect(parseResponsesSources({ output: [{ type: 'web_search_call' }] })).toEqual([]);
      expect(parseResponsesSources({})).toEqual([]);
    });

    it('drops annotations with no url', () => {
      const sources = parseResponsesSources({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: TEXT,
                annotations: [{ type: 'url_citation', title: 'NoUrl' }],
              },
            ],
          },
        ],
      });
      expect(sources).toEqual([]);
    });
  });

  describe('retrieve (mocked fetch)', () => {
    it('returns parsed sources from the Responses API', async () => {
      mockFetch.mockResolvedValueOnce(
        makeResponse('SPANSPAN tower facts', [
          { type: 'url_citation', title: 'Britannica', url: 'https://britannica.com/x', start_index: 0, end_index: 8 },
        ]),
      );
      const retriever = new OpenAIWebSearchRetriever('test-key');
      const sources = await retriever.retrieve('The Eiffel Tower is in Paris');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.tools).toEqual([{ type: 'web_search' }]);
      expect(body.model).toBe('gpt-4o');
      expect(body.input).toContain('The Eiffel Tower is in Paris');

      expect(sources).toEqual([
        { title: 'Britannica', uri: 'https://britannica.com/x', snippet: 'SPANSPAN' },
      ]);
    });

    it('returns [] (never throws) on a non-ok API response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' });
      const retriever = new OpenAIWebSearchRetriever('test-key');
      await expect(retriever.retrieve('claim')).resolves.toEqual([]);
    });

    it('returns [] without calling the API when the key is empty', async () => {
      const retriever = new OpenAIWebSearchRetriever('');
      await expect(retriever.retrieve('claim')).resolves.toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('honors FAULTLINE_OPENAI_SEARCH_MODEL override', async () => {
      process.env.FAULTLINE_OPENAI_SEARCH_MODEL = 'gpt-4o-mini';
      mockFetch.mockResolvedValueOnce(makeResponse('t', []));
      const retriever = new OpenAIWebSearchRetriever('test-key');
      await retriever.retrieve('claim');
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.model).toBe('gpt-4o-mini');
    });
  });

  describe('retrieveWithStatus (stubbed fetch)', () => {
    const jsonReply = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body });

    it('hits: a 2xx reply with citations returns its sources', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse('SPANSPAN facts', [
        { type: 'url_citation', title: 'Britannica', url: 'https://britannica.com/x', start_index: 0, end_index: 8 },
      ]));
      const out = await new OpenAIWebSearchRetriever('test-key').retrieveWithStatus('claim');
      expect(out.sources.length).toBeGreaterThan(0);
      expect(out.status).toBe('hits');
      expect(out.sources[0].uri).toBe('https://britannica.com/x');
      expect(out.detail).toBeUndefined();
    });

    it('zero: a well-formed 2xx reply that cites nothing', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse('No sources were found.', []));
      const out = await new OpenAIWebSearchRetriever('test-key').retrieveWithStatus('claim');
      expect(out).toEqual({ status: 'zero', sources: [] });
    });

    it('timeout: the call was aborted by its deadline', async () => {
      mockFetch.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
      const r = new OpenAIWebSearchRetriever('test-key', { timeoutMs: 5 });
      const out = await r.retrieveWithStatus('claim');
      expect(out.status).toBe('timeout');
      expect(out.sources).toEqual([]);
      mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));
      expect((await r.retrieveWithStatus('claim')).status).toBe('timeout');
      mockFetch.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
      await expect(r.retrieve('claim')).resolves.toEqual([]);
    });

    it('provider_error: an HTTP 500, with the status code as the only detail', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });
      const out = await new OpenAIWebSearchRetriever('test-key').retrieveWithStatus('claim');
      expect(out).toEqual({ status: 'provider_error', sources: [], detail: 'http 500' });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });
      await expect(new OpenAIWebSearchRetriever('test-key').retrieve('claim')).resolves.toEqual([]);
    });

    it('provider_error: a network error', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
      const out = await new OpenAIWebSearchRetriever('test-key').retrieveWithStatus('claim');
      expect(out).toEqual({ status: 'provider_error', sources: [], detail: 'network error' });
    });

    it('provider_error: a missing API key, with no request made', async () => {
      const r = new OpenAIWebSearchRetriever('');
      expect(await r.retrieveWithStatus('claim')).toEqual({ status: 'provider_error', sources: [], detail: 'missing api key' });
      await expect(r.retrieve('claim')).resolves.toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('parse_error: a 2xx reply that is not JSON, or has no output list', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', json: async () => { throw new SyntaxError('Unexpected token <'); } });
      const r = new OpenAIWebSearchRetriever('test-key');
      expect(await r.retrieveWithStatus('claim')).toEqual({ status: 'parse_error', sources: [], detail: 'bad json' });
      mockFetch.mockResolvedValueOnce(jsonReply({ output: 'not-a-list' }));
      expect(await r.retrieveWithStatus('claim')).toEqual({ status: 'parse_error', sources: [], detail: 'unexpected shape' });
      mockFetch.mockResolvedValueOnce(jsonReply({ output: [{ type: 'message', content: 'not-a-list' }] }));
      expect((await r.retrieveWithStatus('claim')).status).toBe('parse_error');
      mockFetch.mockResolvedValueOnce(jsonReply(null));
      await expect(r.retrieve('claim')).resolves.toEqual([]);
    });

    it('policy_block: a Responses refusal or a content-filter stop', async () => {
      mockFetch.mockResolvedValueOnce(jsonReply({
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }],
      }));
      const r = new OpenAIWebSearchRetriever('test-key');
      const out = await r.retrieveWithStatus('claim');
      expect(out).toEqual({ status: 'policy_block', sources: [], detail: 'refusal' });
      // The refusal text is the provider's words: it never reaches the outcome.
      expect(JSON.stringify(out)).not.toContain('cannot help');
      mockFetch.mockResolvedValueOnce(jsonReply({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }));
      expect(await r.retrieveWithStatus('claim')).toEqual({ status: 'policy_block', sources: [], detail: 'content filter' });
      mockFetch.mockResolvedValueOnce(jsonReply({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }));
      await expect(r.retrieve('claim')).resolves.toEqual([]);
    });

    it('a cut-off reply is provider_error, and the debug line names only the status', async () => {
      process.env.FAULTLINE_DEBUG = '1';
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      mockFetch.mockResolvedValueOnce(jsonReply({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }));
      const out = await new OpenAIWebSearchRetriever('test-key').retrieveWithStatus('SECRET CLAIM TEXT');
      expect(out).toEqual({ status: 'provider_error', sources: [], detail: 'output truncated' });
      const logged = write.mock.calls.map((c) => String(c[0])).join('');
      expect(logged.length).toBeGreaterThan(0);
      expect(logged).toContain('provider_error');
      expect(logged).not.toContain('SECRET CLAIM TEXT');
      write.mockRestore();
    });
  });

  it('exposes a stable retriever name', () => {
    expect(new OpenAIWebSearchRetriever('k').name).toBe('openai-web-search');
  });
});
