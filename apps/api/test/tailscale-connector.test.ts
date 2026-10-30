// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { Router } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TailscaleConnector,
  TailscaleConnectorError,
  type CommandResult,
  type TailscaleCommandRunner,
} from '../src/tailscale-connector.js';
import { TailnetApprovalStore } from '../src/tailnet-tcp.js';
import { registerNetworkRoutes } from '../src/network-routes.js';

/**
 * Fake tailscale CLI. States: out (NeedsLogin) → running → stopped
 * (after `down`, identity still present) → out (after `logout`,
 * identity erased — mirrors real CLI semantics).
 */
function fakeCli(opts: { approvalFlow?: boolean } = {}) {
  let state: 'out' | 'running' | 'stopped' = 'out';
  let approved = !opts.approvalFlow;
  const calls: string[][] = [];
  const selfNode = {
    ID: 'node-self', HostName: 'kriyadot-host', DNSName: 'kriyadot-host.tailnet.ts.net.',
    TailscaleIPs: ['100.64.0.5', 'fd7a:115c:a1e0::5'],
  };
  const runner: TailscaleCommandRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'status') {
      if (state === 'running') {
        return {
          code: 0, stderr: '',
          stdout: JSON.stringify({
            BackendState: 'Running', Self: selfNode, CurrentTailnet: { Name: 'tailnet.ts.net' },
            Peer: {
              n2: { ID: 'node-phone', HostName: 'pixel', DNSName: 'pixel.tailnet.ts.net.', TailscaleIPs: ['100.64.0.6'], Online: true, OS: 'android' },
            },
          }),
        };
      }
      if (state === 'stopped') {
        return { code: 0, stderr: '', stdout: JSON.stringify({ BackendState: 'Stopped', Self: selfNode, CurrentTailnet: { Name: 'tailnet.ts.net' } }) };
      }
      return { code: 0, stderr: '', stdout: JSON.stringify({ BackendState: 'NeedsLogin' }) };
    }
    if (args[0] === 'up') {
      if (!approved) {
        return { code: 0, stdout: 'To authenticate, visit:\n\thttps://login.tailscale.com/a/abc123\n', stderr: '' };
      }
      state = 'running';
      return { code: 0, stdout: 'Success.', stderr: '' };
    }
    if (args[0] === 'down') { if (state === 'running') state = 'stopped'; return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'logout') { state = 'out'; return { code: 0, stdout: '', stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unknown command' } as CommandResult;
  };
  return { runner, calls, approve: () => { approved = true; } };
}

function tmpStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'tailscale-conn-'));
}

describe('TailscaleConnector (DV-17/DV-18)', () => {
  it('status reports not-joined before join, joined with peers after', async () => {
    const dir = tmpStateDir();
    const cli = fakeCli();
    const conn = new TailscaleConnector({ stateDir: dir, runner: cli.runner });
    const before = await conn.status();
    expect(before.joined).toBe(false);
    expect(before.self).toBeNull();

    const joined = await conn.join();
    expect(joined.status.joined).toBe(true);
    expect(joined.status.self?.addresses).toContain('100.64.0.5');
    expect(joined.status.peers).toHaveLength(1);
    expect(joined.status.peers[0].dnsName).toBe('pixel.tailnet.ts.net');
    expect(joined.authUrl).toBeNull();
    // Identity record persisted (0600 metadata file, no secrets).
    expect(existsSync(join(dir, 'tailscale-connector.json'))).toBe(true);
    expect(conn.readIdentity()?.nodeId).toBe('node-self');
  });

  it('join surfaces the auth URL when the control server wants approval', async () => {
    const dir = tmpStateDir();
    const cli = fakeCli({ approvalFlow: true });
    const conn = new TailscaleConnector({ stateDir: dir, runner: cli.runner });
    const pending = await conn.join();
    expect(pending.status.joined).toBe(false);
    expect(pending.authUrl).toBe('https://login.tailscale.com/a/abc123');
    expect(conn.readIdentity()).toBeNull();
    cli.approve();
    const done = await conn.join();
    expect(done.status.joined).toBe(true);
  });

  it('Headscale join passes --login-server; non-https servers are rejected before any CLI call', async () => {
    const dir = tmpStateDir();
    const cli = fakeCli();
    const conn = new TailscaleConnector({ stateDir: dir, runner: cli.runner });
    await conn.join({ loginServer: 'https://headscale.example.com' });
    const upCall = cli.calls.find((c) => c[0] === 'up');
    expect(upCall).toEqual(['up', '--login-server', 'https://headscale.example.com']);
    expect(conn.readIdentity()?.loginServer).toBe('https://headscale.example.com');

    const callsBefore = cli.calls.length;
    await expect(conn.join({ loginServer: 'http://insecure.example.com' })).rejects.toBeInstanceOf(TailscaleConnectorError);
    expect(cli.calls.length).toBe(callsBefore);
  });

  it('disconnect ERASES the identity: down + logout run, record deleted, erasure verified', async () => {
    const dir = tmpStateDir();
    const cli = fakeCli();
    const conn = new TailscaleConnector({ stateDir: dir, runner: cli.runner });
    await conn.join();
    expect(conn.readIdentity()).not.toBeNull();

    const result = await conn.disconnect();
    expect(result.disconnected).toBe(true);
    expect(result.identityErased).toBe(true);
    // Erasure mechanism: both down and logout were invoked.
    expect(cli.calls.some((c) => c[0] === 'down')).toBe(true);
    expect(cli.calls.some((c) => c[0] === 'logout')).toBe(true);
    // Erasure verified: no identity record on disk, none in status.
    expect(existsSync(join(dir, 'tailscale-connector.json'))).toBe(false);
    expect(conn.readIdentity()).toBeNull();
    const status = await conn.status();
    expect(status.joined).toBe(false);
    expect(status.self).toBeNull();
  });

  it('a missing tailscale CLI surfaces tailscale_unavailable', async () => {
    const conn = new TailscaleConnector({
      stateDir: tmpStateDir(),
      runner: async () => ({ code: 127, stdout: '', stderr: 'tailscale_cli_not_found' }),
    });
    await expect(conn.status()).rejects.toMatchObject({ code: 'tailscale_unavailable' });
  });
});

describe('network routes', () => {
  let base = '';
  let server: ReturnType<express.Express['listen']>;
  let conn: TailscaleConnector;
  let dir: string;

  beforeAll(async () => {
    dir = tmpStateDir();
    const cli = fakeCli();
    conn = new TailscaleConnector({ stateDir: dir, runner: cli.runner });
    const approvals = new TailnetApprovalStore(dir);
    const app = express();
    app.use(express.json());
    const router = Router();
    registerNetworkRoutes(router, {
      connector: conn,
      approvals,
      dial: async () => ({ end: () => {}, destroy: () => {}, on: () => {} }),
    });
    app.use('/api/network', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/network`;
  });

  afterAll(() => server.close());

  it('join → status → governed probe → disconnect-erases over HTTP', async () => {
    const joinRes = await fetch(`${base}/tailscale/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(joinRes.status).toBe(200);
    const status = (await (await fetch(`${base}/tailscale/status`)).json()) as { status: { joined: boolean } };
    expect(status.status.joined).toBe(true);

    // Probe before approval → 403 host_not_approved.
    const refused = await fetch(`${base}/tcp/probe`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'pixel.tailnet.ts.net', port: 22 }),
    });
    expect(refused.status).toBe(403);

    const grant = await fetch(`${base}/tcp/approvals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'pixel.tailnet.ts.net' }),
    });
    expect(grant.status).toBe(201);

    const probe = (await (await fetch(`${base}/tcp/probe`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'pixel.tailnet.ts.net', port: 22 }),
    })).json()) as { reachable: boolean };
    expect(probe.reachable).toBe(true);

    const disc = (await (await fetch(`${base}/tailscale/disconnect`, { method: 'POST' })).json()) as { identityErased: boolean };
    expect(disc.identityErased).toBe(true);
    expect(existsSync(join(dir, 'tailscale-connector.json'))).toBe(false);
  });
});
