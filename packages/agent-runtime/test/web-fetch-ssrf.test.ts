// SPDX-License-Identifier: Apache-2.0
// Tests for the web_fetch SSRF gate (M2). Fully offline: DNS and fetch are
// stubbed. No real network, no paid APIs.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable DNS table, shared with the hoisted node:dns mock below.
const dnsState = vi.hoisted(() => ({ records: new Map<string, string[]>() }));

vi.mock('node:dns', () => ({
  lookup: (
    host: string,
    opts: { all: boolean },
    cb: (err: Error | null, addrs?: Array<{ address: string; family: number }>) => void,
  ) => {
    void opts;
    const ips = dnsState.records.get(host);
    if (!ips) {
      cb(Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
      return;
    }
    cb(
      null,
      ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
  },
}));

const fetchCalls: string[] = [];
let fetchHandler: (url: string) => Response = () => {
  throw new Error('fetch not stubbed for this test');
};
vi.stubGlobal('fetch', (async (url: string) => {
  fetchCalls.push(url);
  return fetchHandler(url);
}) as typeof fetch);

import { createBuiltInTools, isBlockedFetchIp } from '../src/tools/builtin.js';
import type { ToolContext } from '../src/types.js';

const CTX: ToolContext = { sessionId: 's', botId: 'b' };

async function webFetch(args: Record<string, unknown>): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'ssrf-'));
  const tools = createBuiltInTools({ workspaceDir: dir });
  const tool = tools.find((t) => t.name === 'web_fetch')!;
  return tool.handler(args, CTX);
}

const PUBLIC_HTML =
  '<html><head><title>Example</title></head><body><p>hello world</p></body></html>';

beforeEach(() => {
  dnsState.records.clear();
  fetchCalls.length = 0;
  fetchHandler = () => new Response(PUBLIC_HTML, { status: 200 });
});

describe('isBlockedFetchIp', () => {
  it('blocks loopback, private, link-local, multicast and 0.0.0.0', () => {
    for (const ip of [
      '127.0.0.1',
      '127.45.67.89',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      '::ffff:127.0.0.1',
      'fe80::1',
      'fc00::1',
    ]) {
      expect(isBlockedFetchIp(ip)).toBe(true);
    }
  });

  it('allows public IPs', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isBlockedFetchIp(ip)).toBe(false);
    }
  });
});

describe('web_fetch SSRF gate', () => {
  it('rejects hostnames resolving to loopback without fetching', async () => {
    dnsState.records.set('internal.example', ['127.0.0.1']);
    await expect(webFetch({ url: 'http://internal.example/admin' })).rejects.toThrow(/non-public/);
    expect(fetchCalls).toHaveLength(0);
  });

  it('rejects DNS-rebinding hosts when ANY record is private', async () => {
    dnsState.records.set('evil.example', ['93.184.216.34', '10.1.2.3']);
    await expect(webFetch({ url: 'http://evil.example/' })).rejects.toThrow(/non-public/);
    expect(fetchCalls).toHaveLength(0);
  });

  it('rejects literal private IPs without DNS', async () => {
    await expect(webFetch({ url: 'http://10.0.0.5/secret' })).rejects.toThrow(/non-public/);
    await expect(webFetch({ url: 'http://169.254.169.254/latest/meta-data' })).rejects.toThrow(
      /non-public/,
    );
    expect(fetchCalls).toHaveLength(0);
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(webFetch({ url: 'file:///etc/passwd' })).rejects.toThrow(/Only http\(s\)/);
    await expect(webFetch({ url: 'gopher://example.com/' })).rejects.toThrow(/Only http\(s\)/);
  });

  it('rejects DNS failures', async () => {
    await expect(webFetch({ url: 'http://nonexistent.invalid/' })).rejects.toThrow(
      /DNS lookup failed/,
    );
  });

  it('allows legitimate public fetches', async () => {
    dnsState.records.set('example.com', ['93.184.216.34']);
    const res = (await webFetch({ url: 'https://example.com/' })) as {
      url: string;
      title: string;
      text: string;
    };
    expect(res.title).toBe('Example');
    expect(res.text).toContain('hello world');
    expect(fetchCalls).toHaveLength(1);
  });

  it('rejects redirects into private IPs (re-validates each hop)', async () => {
    dnsState.records.set('example.com', ['93.184.216.34']);
    fetchHandler = (url: string) => {
      if (url.startsWith('https://example.com/')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        });
      }
      return new Response(PUBLIC_HTML, { status: 200 });
    };
    await expect(webFetch({ url: 'https://example.com/start' })).rejects.toThrow(/non-public/);
    // Only the first hop was fetched; the redirect target was blocked first.
    expect(fetchCalls).toHaveLength(1);
  });

  it('follows redirects to public URLs', async () => {
    dnsState.records.set('example.com', ['93.184.216.34']);
    dnsState.records.set('cdn.example.net', ['151.101.1.1']);
    fetchHandler = (url: string) => {
      if (url.startsWith('https://example.com/')) {
        return new Response(null, { status: 301, headers: { location: 'https://cdn.example.net/x' } });
      }
      return new Response(PUBLIC_HTML, { status: 200 });
    };
    const res = (await webFetch({ url: 'https://example.com/start' })) as { text: string };
    expect(res.text).toContain('hello world');
    expect(fetchCalls).toHaveLength(2);
  });

  it('stops after too many redirects', async () => {
    dnsState.records.set('example.com', ['93.184.216.34']);
    fetchHandler = (url: string) =>
      new Response(null, { status: 302, headers: { location: `${url}/loop` } });
    await expect(webFetch({ url: 'https://example.com/start' })).rejects.toThrow(
      /Too many redirects/,
    );
  });
});
