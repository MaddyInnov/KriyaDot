// SPDX-License-Identifier: Apache-2.0
// web_search provider chain (§2.11 #123): keyed provider first when
// SEARCH_PROVIDER + key are configured, keyless DuckDuckGo fallback on
// failure, keyless default unchanged. All fetch stubbed — zero network.

import { describe, expect, it } from 'vitest';
import { createBuiltInTools, resolveSearchProviders, searchWeb } from '../src/index.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const DDG_BODY = {
  AbstractText: 'DDG abstract',
  AbstractURL: 'https://example.com/ddg',
  RelatedTopics: [{ Text: 'topic one', FirstURL: 'https://example.com/1' }],
};

describe('resolveSearchProviders', () => {
  it('defaults to keyless duckduckgo only', () => {
    expect(resolveSearchProviders({})).toEqual(['duckduckgo']);
  });
  it('puts brave first when selected with a key', () => {
    expect(resolveSearchProviders({ SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'k' })).toEqual([
      'brave',
      'duckduckgo',
    ]);
  });
  it('ignores a selected provider whose key is missing', () => {
    expect(resolveSearchProviders({ SEARCH_PROVIDER: 'tavily' })).toEqual(['duckduckgo']);
  });
  it('ignores unknown provider values', () => {
    expect(resolveSearchProviders({ SEARCH_PROVIDER: 'bing', BRAVE_API_KEY: 'k' })).toEqual([
      'duckduckgo',
    ]);
  });
});

describe('searchWeb chain', () => {
  it('keyless default: DDG result shape unchanged', async () => {
    const fetchFn = async () => jsonResponse(DDG_BODY);
    const out = await searchWeb('q', { fetchFn: fetchFn as typeof fetch, env: {} });
    expect(out).toEqual({
      abstract: 'DDG abstract',
      source: 'https://example.com/ddg',
      topics: [{ text: 'topic one', url: 'https://example.com/1' }],
    });
  });

  it('keyed brave success: normalized to the same shape, DDG never called', async () => {
    const urls: string[] = [];
    const fetchFn = async (url: string) => {
      urls.push(String(url));
      return jsonResponse({
        web: {
          results: [
            { title: 'T1', url: 'https://b.example/1', description: 'brave desc' },
            { title: 'T2', url: 'https://b.example/2', description: 'second' },
          ],
        },
      });
    };
    const out = await searchWeb('q', {
      fetchFn: fetchFn as typeof fetch,
      env: { SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'key-1' },
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('api.search.brave.com');
    expect(out.abstract).toBe('brave desc');
    expect(out.source).toBe('https://b.example/1');
    expect(out.topics).toHaveLength(2);
  });

  it('keyed tavily success via POST', async () => {
    const fetchFn = async (_url: string, init?: { method?: string }) => {
      expect(init?.method).toBe('POST');
      return jsonResponse({
        answer: 'tavily answer',
        results: [{ title: 'R', url: 'https://t.example/1', content: 'content one' }],
      });
    };
    const out = await searchWeb('q', {
      fetchFn: fetchFn as typeof fetch,
      env: { SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'tv-1' },
    });
    expect(out.abstract).toBe('tavily answer');
    expect(out.topics[0]).toEqual({ text: 'content one', url: 'https://t.example/1' });
  });

  it('keyed failure falls back to keyless DDG', async () => {
    const fetchFn = async (url: string) => {
      if (String(url).includes('brave')) return jsonResponse({}, false, 429);
      return jsonResponse(DDG_BODY);
    };
    const out = await searchWeb('q', {
      fetchFn: fetchFn as typeof fetch,
      env: { SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'key-1' },
    });
    expect(out.abstract).toBe('DDG abstract');
  });

  it('throws the last error when every provider fails', async () => {
    const fetchFn = async () => jsonResponse({}, false, 503);
    await expect(
      searchWeb('q', {
        fetchFn: fetchFn as typeof fetch,
        env: { SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'key-1' },
      }),
    ).rejects.toThrow(/DuckDuckGo search failed: HTTP 503/);
  });

  it('the web_search tool handler uses the injected chain', async () => {
    const fetchFn = async () => jsonResponse(DDG_BODY);
    const tools = createBuiltInTools({
      workspaceDir: '/tmp',
      fetchFn: fetchFn as typeof fetch,
      env: {},
    });
    const tool = tools.find((t) => t.name === 'web_search')!;
    const out = (await tool.handler({ query: 'hello' }, {} as never)) as { abstract: string };
    expect(out.abstract).toBe('DDG abstract');
  });
});
