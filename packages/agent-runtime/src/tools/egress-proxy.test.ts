// SPDX-License-Identifier: Apache-2.0
//
// A13 egress journal tests. Everything runs against throwaway servers
// on 127.0.0.1 — zero paid APIs, zero external network.

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  egressJournalEnabledFromEnv,
  egressJournalSettings,
  httpTargetOf,
  parseAuthority,
  startEgressProxy,
  type EgressJournalEntry,
} from './egress-proxy.js';
import { executeSandboxedCommand } from './sandbox.js';

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise((server.address() as AddressInfo).port));
  });
}

function closeServer(server: http.Server | net.Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

/** Minimal origin server: echoes a fixed body, records what it saw. */
async function startOrigin(body = 'origin-body'): Promise<{ port: number; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  const port = await listen(server);
  return { port, seen, close: () => closeServer(server) };
}

/** GET via the proxy using absolute-form (standard forward-proxy request). */
function httpViaProxy(proxyPort: number, targetUrl: string, runId?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers: Record<string, string> = {};
    if (runId) {
      headers['proxy-authorization'] = 'Basic ' + Buffer.from(`${runId}:x`).toString('base64');
    }
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: targetUrl, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

/** CONNECT to the proxy, then speak plain HTTP inside the tunnel. */
function connectViaProxy(proxyPort: number, targetPort: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    let tunnelOpen = false;
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!tunnelOpen && buf.includes('\r\n\r\n')) {
        if (!buf.toString('utf8').startsWith('HTTP/1.1 200')) {
          socket.destroy();
          rejectPromise(new Error(`CONNECT refused: ${buf.toString('utf8').slice(0, 60)}`));
          return;
        }
        tunnelOpen = true;
        buf = buf.subarray(buf.indexOf('\r\n\r\n') + 4);
        socket.write('GET /inside-tunnel?token=tunnel-secret HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      }
      if (tunnelOpen && buf.toString('utf8').includes('origin-body')) {
        const out = buf.toString('utf8');
        socket.destroy();
        resolvePromise(out);
      }
    });
    socket.on('error', rejectPromise);
    setTimeout(() => rejectPromise(new Error('CONNECT test timed out')), 5_000).unref();
  });
}

describe('egress target parsing (host:port only)', () => {
  it('parses CONNECT authorities', () => {
    expect(parseAuthority('Example.COM:443')).toEqual({ host: 'example.com', port: 443 });
    expect(parseAuthority('127.0.0.1:8080')).toEqual({ host: '127.0.0.1', port: 8080 });
    expect(parseAuthority('[::1]:8443')).toEqual({ host: '::1', port: 8443 });
    expect(parseAuthority('')).toBeNull();
    expect(parseAuthority('host:notaport')).toBeNull();
  });

  it('extracts host:port from absolute-form and Host header, dropping paths', () => {
    const abs = { url: 'http://127.0.0.1:9123/secret-path?token=x', headers: {} } as http.IncomingMessage;
    expect(httpTargetOf(abs)).toEqual({ host: '127.0.0.1', port: 9123 });
    const originForm = { url: '/secret', headers: { host: 'example.com' } } as unknown as http.IncomingMessage;
    expect(httpTargetOf(originForm)).toEqual({ host: 'example.com', port: 80 });
  });

  it('settings are OFF by default and env opt-in is explicit', () => {
    expect(egressJournalEnabledFromEnv({})).toBe(false);
    expect(egressJournalEnabledFromEnv({ KRIYADOT_EGRESS_JOURNAL: '0' })).toBe(false);
    expect(egressJournalEnabledFromEnv({ KRIYADOT_EGRESS_JOURNAL: '1' })).toBe(true);
  });
});

describe('egress proxy', () => {
  it('forwards plain HTTP and journals host:port with NO path/query leakage', async () => {
    const origin = await startOrigin();
    const entries: EgressJournalEntry[] = [];
    const proxy = await startEgressProxy({ runId: 'run-http-1', sink: (e) => void entries.push(e) });
    try {
      const res = await httpViaProxy(proxy.port, `http://127.0.0.1:${origin.port}/secret-path?token=x`);
      expect(res.status).toBe(200);
      expect(res.body).toBe('origin-body');
      // The origin DID receive the full path (standard proxy behaviour)…
      expect(origin.seen[0]).toContain('/secret-path?token=x');
      await waitFor(() => entries.length >= 1);
      const entry = entries[0]!;
      expect(entry.runId).toBe('run-http-1');
      expect(entry.host).toBe('127.0.0.1');
      expect(entry.port).toBe(origin.port);
      expect(entry.status).toBe('forwarded');
      expect(entry.bytesDown).toBeGreaterThan(0);
      // …but the journal entry contains ONLY host:port + counters.
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain('secret-path');
      expect(serialized).not.toContain('token');
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it('attributes entries to the run id carried as the proxy credential', async () => {
    const origin = await startOrigin();
    const entries: EgressJournalEntry[] = [];
    const proxy = await startEgressProxy({ runId: 'run-default', sink: (e) => void entries.push(e) });
    try {
      await httpViaProxy(proxy.port, `http://127.0.0.1:${origin.port}/a`, 'run-from-credential');
      await waitFor(() => entries.length >= 1);
      expect(entries[0]!.runId).toBe('run-from-credential');
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it('CONNECT tunnels and journals host/port/bytes with no path leakage', async () => {
    const origin = await startOrigin();
    const entries: EgressJournalEntry[] = [];
    const proxy = await startEgressProxy({ runId: 'run-connect-1', sink: (e) => void entries.push(e) });
    try {
      const out = await connectViaProxy(proxy.port, origin.port);
      expect(out).toContain('origin-body');
      await waitFor(() => entries.length >= 1);
      const entry = entries[0]!;
      expect(entry).toMatchObject({ runId: 'run-connect-1', host: '127.0.0.1', port: origin.port, status: 'tunnel-established' });
      expect(entry.bytesUp).toBeGreaterThan(0);
      expect(entry.bytesDown).toBeGreaterThan(0);
      expect(JSON.stringify(entries)).not.toContain('inside-tunnel');
      expect(JSON.stringify(entries)).not.toContain('tunnel-secret');
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it('journals tunnel-failed for an unreachable CONNECT target', async () => {
    const entries: EgressJournalEntry[] = [];
    const proxy = await startEgressProxy({ runId: 'run-fail-1', sink: (e) => void entries.push(e) });
    try {
      // Grab a port, then free it so connects are refused.
      const probe = net.createServer();
      const deadPort = await listen(probe);
      await closeServer(probe);
      await expect(connectViaProxy(proxy.port, deadPort)).rejects.toThrow();
      await waitFor(() => entries.length >= 1);
      expect(entries[0]).toMatchObject({ host: '127.0.0.1', port: deadPort, status: 'tunnel-failed' });
    } finally {
      await proxy.close();
    }
  });

  it('a throwing journal sink never breaks the tunnel or the forwarding', async () => {
    const origin = await startOrigin();
    const proxy = await startEgressProxy({
      runId: 'run-badsink',
      sink: () => {
        throw new Error('journal store is down');
      },
    });
    try {
      const res = await httpViaProxy(proxy.port, `http://127.0.0.1:${origin.port}/ok`);
      expect(res.status).toBe(200);
      const out = await connectViaProxy(proxy.port, origin.port);
      expect(out).toContain('origin-body');
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it('binds localhost only and exposes credentialed proxy env with emptied NO_PROXY', async () => {
    const proxy = await startEgressProxy({ runId: 'run-env', sink: () => undefined });
    try {
      expect(proxy.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(proxy.env.HTTP_PROXY).toContain('run-env@127.0.0.1');
      expect(proxy.env.HTTPS_PROXY).toBe(proxy.env.HTTP_PROXY);
      expect(proxy.env.http_proxy).toBe(proxy.env.HTTP_PROXY);
      expect(proxy.env.https_proxy).toBe(proxy.env.HTTP_PROXY);
      expect(proxy.env.NO_PROXY).toBe('');
    } finally {
      await proxy.close();
    }
  });
});

describe('sandbox integration (host backend)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const KEYS = ['SANDBOX_BACKEND', 'SANDBOX_ALLOW_HOST', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  beforeEach(() => {
    for (const k of KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SANDBOX_BACKEND = 'host';
    process.env.SANDBOX_ALLOW_HOST = '1';
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('proxy env is ABSENT when egress journaling is not requested (disabled)', async () => {
    const res = await executeSandboxedCommand('echo "P=[$HTTP_PROXY][$http_proxy]"', {});
    expect(res.stdout).toContain('P=[][]');
    expect(res.egressJournal).toBeUndefined();
  });

  it('a sandboxed curl through the enabled path is journaled host:port only', async () => {
    const origin = await startOrigin();
    const entries: EgressJournalEntry[] = [];
    try {
      const res = await executeSandboxedCommand(
        `curl -s http://127.0.0.1:${origin.port}/secret-path?token=x`,
        { egressJournal: { runId: 'run-sandbox-1', sink: (e) => void entries.push(e) } },
      );
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('origin-body');
      expect(res.egressJournal).toBe('on');
      expect(res.egressNote).toContain('Visible, not confined');
      await waitFor(() => entries.length >= 1);
      const entry = entries.find((e) => e.status === 'forwarded') ?? entries[0]!;
      expect(entry.runId).toBe('run-sandbox-1');
      expect(entry.host).toBe('127.0.0.1');
      expect(entry.port).toBe(origin.port);
      expect(JSON.stringify(entries)).not.toContain('secret-path');
      expect(JSON.stringify(entries)).not.toContain('token=x');
    } finally {
      await origin.close();
    }
  });

  it('the run proceeds WITHOUT proxy env when the proxy fails to start', async () => {
    // Occupy the port the proxy would bind → startEgressProxy throws.
    const blocker = net.createServer();
    const blockedPort = await listen(blocker);
    const entries: EgressJournalEntry[] = [];
    try {
      const res = await executeSandboxedCommand('echo "P=[$HTTP_PROXY]" && echo mission-ok', {
        egressJournal: { runId: 'run-noproxy', sink: (e) => void entries.push(e), port: blockedPort },
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('mission-ok');
      expect(res.stdout).toContain('P=[]');
      expect(res.egressJournal).toBe('unavailable');
      expect(res.egressNote).toContain('WITHOUT proxy env');
      // The unavailability itself is journaled — never silently implied.
      expect(entries.some((e) => e.status === 'unavailable' && e.runId === 'run-noproxy')).toBe(true);
    } finally {
      await closeServer(blocker);
    }
  });

  it('settings holder toggles and resets (default OFF posture)', () => {
    const before = egressJournalSettings.isEnabled;
    egressJournalSettings.updateSettings({ enabled: true });
    expect(egressJournalSettings.isEnabled).toBe(true);
    egressJournalSettings.updateSettings({ enabled: false });
    expect(egressJournalSettings.isEnabled).toBe(false);
    egressJournalSettings.updateSettings({ enabled: before });
  });
});
