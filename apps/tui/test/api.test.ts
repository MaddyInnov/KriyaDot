// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, KriyaDotApi, parseChatEvent, pumpSse } from '../src/api.js';

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}

describe('parseChatEvent', () => {
  it('parses token events', () => {
    expect(parseChatEvent('{"type":"token","content":"hi"}')).toEqual({ type: 'token', content: 'hi' });
  });

  it('parses approval_required with call details', () => {
    const ev = parseChatEvent('{"type":"approval_required","approvalId":"a1","call":{"name":"run_command","arguments":{"cmd":"ls"}}}');
    expect(ev).toEqual({
      type: 'approval_required',
      approvalId: 'a1',
      call: { name: 'run_command', arguments: { cmd: 'ls' } },
    });
  });

  it('parses done/error/interrupted/notice', () => {
    expect(parseChatEvent('{"type":"done","usage":{"inputTokens":3}}').type).toBe('done');
    expect(parseChatEvent('{"type":"error","message":"boom"}')).toEqual({ type: 'error', message: 'boom' });
    expect(parseChatEvent('{"type":"interrupted","reason":"x"}').type).toBe('interrupted');
    expect(parseChatEvent('{"type":"notice","kind":"info","message":"m"}').type).toBe('notice');
  });

  it('never throws on garbage', () => {
    expect(parseChatEvent('not json')).toEqual({ type: 'unknown', raw: 'not json' });
    expect(parseChatEvent('{"type":"weird"}')).toEqual({ type: 'unknown', raw: { type: 'weird' } });
    expect(parseChatEvent('[1,2]')).toEqual({ type: 'unknown', raw: [1, 2] });
  });
});

describe('pumpSse', () => {
  it('delivers data frames and ignores heartbeats', async () => {
    const seen: string[] = [];
    await pumpSse(
      sseStream([': heartbeat\n\n', 'data: {"type":"token","content":"a"}\n\n', 'data: {"type":"done"}\n\n']),
      (ev) => seen.push(ev.type),
    );
    expect(seen).toEqual(['token', 'done']);
  });

  it('handles frames split across chunks', async () => {
    const seen: string[] = [];
    await pumpSse(sseStream(['data: {"type":"to', 'ken","content":"x"}\n\n']), (ev) => seen.push(ev.type));
    expect(seen).toEqual(['token']);
  });

  it('skips [DONE] sentinels', async () => {
    const seen: string[] = [];
    await pumpSse(sseStream(['data: [DONE]\n\n']), (ev) => seen.push(ev.type));
    expect(seen).toEqual([]);
  });
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => handler(url, init)),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('KriyaDotApi', () => {
  it('health() returns true on ok', async () => {
    mockFetch(() => jsonResponse({ ok: true }));
    expect(await new KriyaDotApi('http://x:4000').health()).toBe(true);
  });

  it('health() returns false when unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    expect(await new KriyaDotApi('http://x:4000').health()).toBe(false);
  });

  it('listBots hits /api/bots', async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(url);
      return jsonResponse([{ id: 'b1', name: 'Helper' }]);
    });
    const bots = await new KriyaDotApi('http://x:4000/').listBots();
    expect(bots).toEqual([{ id: 'b1', name: 'Helper' }]);
    expect(seen).toEqual(['http://x:4000/api/bots']);
  });

  it('throws ApiError with server message on failure', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Unknown bot "zz"' } }, 404));
    const api = new KriyaDotApi('http://x:4000');
    await expect(api.getBotMemory('zz')).rejects.toMatchObject({ status: 404 } as Partial<ApiError>);
    await expect(api.getBotMemory('zz')).rejects.toThrow('Unknown bot "zz"');
  });

  it('decideApproval posts the decision', async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = [];
    mockFetch(async (url, init) => {
      calls.push({ url, method: init?.method, body: String(init?.body ?? '') });
      return jsonResponse({ ok: true });
    });
    await new KriyaDotApi('http://x:4000').decideApproval('a1', 'denied');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://x:4000/api/approvals/a1');
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body)).toEqual({ decision: 'denied' });
  });

  it('setBotModel PUTs the model', async () => {
    const seen: Array<{ url: string; method?: string; body: string }> = [];
    mockFetch(async (url, init) => {
      seen.push({ url, method: init?.method, body: String(init?.body ?? '') });
      return jsonResponse({ ok: true });
    });
    await new KriyaDotApi('http://x:4000').setBotModel('b1', 'llama-3.3-70b');
    expect(seen[0].url).toBe('http://x:4000/api/bots/b1/model');
    expect(seen[0].method).toBe('PUT');
    expect(JSON.parse(seen[0].body)).toEqual({ model: 'llama-3.3-70b' });
  });

  it('wraps network failures in a helpful error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    await expect(new KriyaDotApi('http://x:4000').listBots()).rejects.toThrow('Cannot reach KriyaDot API');
  });
});
