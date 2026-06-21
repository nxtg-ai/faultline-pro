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

  it('exposes a stable retriever name', () => {
    expect(new OpenAIWebSearchRetriever('k').name).toBe('openai-web-search');
  });
});
