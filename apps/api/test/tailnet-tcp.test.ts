// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  TailnetApprovalStore,
  TailnetTcpError,
  connectViaTailnet,
  normalizeTailnetHost,
  probeViaTailnet,
  type TailnetDialer,
} from '../src/tailnet-tcp.js';
import type { TailnetStatus } from '../src/tailscale-connector.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tailnet-tcp-'));
}

const JOINED: TailnetStatus = {
  joined: true, backendState: 'Running', tailnet: 'tailnet.ts.net', loginServer: null,
  self: { id: 'n1', hostName: 'host', dnsName: 'host.tailnet.ts.net', addresses: ['100.64.0.5'] },
  peers: [],
};
const NOT_JOINED: TailnetStatus = { ...JOINED, joined: false, backendState: 'NeedsLogin', self: null };

function connectorWith(status: TailnetStatus) {
  return { status: async () => status };
}

function fakeSocket() {
  return { end: vi.fn(), destroy: vi.fn(), on: vi.fn() };
}

describe('normalizeTailnetHost', () => {
  it('normalizes names, IPs and bracketed IPv6; rejects schemes/ports/paths', () => {
    expect(normalizeTailnetHost('Pixel.Tailnet.TS.net.')).toBe('pixel.tailnet.ts.net');
    expect(normalizeTailnetHost('100.64.0.6')).toBe('100.64.0.6');
    expect(normalizeTailnetHost('[fd7a:115c:a1e0::6]')).toBe('fd7a:115c:a1e0::6');
    expect(() => normalizeTailnetHost('https://evil.example.com')).toThrow(TailnetTcpError);
    expect(() => normalizeTailnetHost('host:22')).toThrow(TailnetTcpError);
    expect(() => normalizeTailnetHost('999.1.1.1')).toThrow(TailnetTcpError);
    expect(() => normalizeTailnetHost('')).toThrow(TailnetTcpError);
  });
});

describe('TailnetApprovalStore', () => {
  it('grant/get/revoke round-trip, persists across instances, prunes expired', () => {
    const dir = tmpDir();
    let now = 1_000_000;
    const store = new TailnetApprovalStore(dir, () => now);
    const a = store.grant('Pixel.Tailnet.TS.net.', { ttlMs: 60_000, note: 'ssh box' });
    expect(a.host).toBe('pixel.tailnet.ts.net');
    expect(store.get('pixel.tailnet.ts.net')?.note).toBe('ssh box');

    const reloaded = new TailnetApprovalStore(dir, () => now);
    expect(reloaded.get('pixel.tailnet.ts.net')).not.toBeNull();

    now += 61_000;
    expect(store.get('pixel.tailnet.ts.net')).toBeNull();
    expect(store.list()).toHaveLength(0);

    store.grant('100.64.0.6');
    expect(store.revoke('100.64.0.6')).toBe(true);
    expect(store.revoke('100.64.0.6')).toBe(false);
  });

  it('approvals are per exact address: a name approval does not cover the IP', () => {
    const store = new TailnetApprovalStore(tmpDir());
    store.grant('pixel.tailnet.ts.net');
    expect(store.get('pixel.tailnet.ts.net')).not.toBeNull();
    expect(store.get('100.64.0.6')).toBeNull();
  });
});

describe('connectViaTailnet (DV-19 governance)', () => {
  it('refuses before dialing when not joined', async () => {
    const dial = vi.fn<TailnetDialer>(async () => fakeSocket());
    const approvals = new TailnetApprovalStore(tmpDir());
    approvals.grant('pixel.tailnet.ts.net');
    await expect(
      connectViaTailnet({ connector: connectorWith(NOT_JOINED), approvals, dial }, 'pixel.tailnet.ts.net', 22),
    ).rejects.toMatchObject({ code: 'tailnet_not_joined' });
    expect(dial).not.toHaveBeenCalled();
  });

  it('refuses before dialing when the host has no approval', async () => {
    const dial = vi.fn<TailnetDialer>(async () => fakeSocket());
    const approvals = new TailnetApprovalStore(tmpDir());
    await expect(
      connectViaTailnet({ connector: connectorWith(JOINED), approvals, dial }, 'pixel.tailnet.ts.net', 22),
    ).rejects.toMatchObject({ code: 'host_not_approved' });
    expect(dial).not.toHaveBeenCalled();
  });

  it('dials only the approved host; one approval covers other ports on that host', async () => {
    const socket = fakeSocket();
    const dial = vi.fn<TailnetDialer>(async () => socket);
    const approvals = new TailnetApprovalStore(tmpDir());
    approvals.grant('pixel.tailnet.ts.net');
    const r1 = await connectViaTailnet({ connector: connectorWith(JOINED), approvals, dial }, 'pixel.tailnet.ts.net', 22);
    expect(r1.socket).toBe(socket);
    const probe = await probeViaTailnet({ connector: connectorWith(JOINED), approvals, dial }, 'pixel.tailnet.ts.net', 8080);
    expect(probe.reachable).toBe(true);
    expect(socket.end).toHaveBeenCalled();
    expect(dial).toHaveBeenCalledTimes(2);
    expect(dial).toHaveBeenCalledWith('pixel.tailnet.ts.net', 8080);
    // A different host is still refused even though one approval exists.
    await expect(
      connectViaTailnet({ connector: connectorWith(JOINED), approvals, dial }, 'other.tailnet.ts.net', 22),
    ).rejects.toMatchObject({ code: 'host_not_approved' });
  });

  it('dial failures surface as dial_failed (never a silent fallback)', async () => {
    const approvals = new TailnetApprovalStore(tmpDir());
    approvals.grant('pixel.tailnet.ts.net');
    const dial: TailnetDialer = async () => { throw new Error('ECONNREFUSED'); };
    await expect(
      connectViaTailnet({ connector: connectorWith(JOINED), approvals, dial }, 'pixel.tailnet.ts.net', 22),
    ).rejects.toMatchObject({ code: 'dial_failed' });
  });

  it('rejects invalid ports before any check or dial', async () => {
    const approvals = new TailnetApprovalStore(tmpDir());
    await expect(
      connectViaTailnet({ connector: connectorWith(JOINED), approvals, dial: async () => fakeSocket() }, 'pixel.tailnet.ts.net', 70000),
    ).rejects.toMatchObject({ code: 'invalid_port' });
  });
});
