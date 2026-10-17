// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcpClient, AcpError, acpOptionsFromBot, type AcpClientOptions } from '../src/acp.js';

/**
 * Mock ACP agent: a node one-liner speaking the minimal protocol over stdio.
 * Responds to initialize and prompt; records nothing.
 */
const MOCK_AGENT = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-agent' } } }) + '\\n');
  } else if (msg.method === 'prompt') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { text: 'mock result for: ' + msg.params.prompt } }) + '\\n');
  }
  // cancel notifications ignored
});
`;

describe('AcpClient', () => {
  it('connects and runs initialize', async () => {
    const client = new AcpClient({ command: 'node', args: ['-e', MOCK_AGENT], cwd: process.cwd() });
    try {
      const info = await client.connect();
      expect(info.agentName).toBe('mock-agent');
    } finally {
      client.close();
    }
  });

  it('prompt returns the agent text', async () => {
    const client = new AcpClient({ command: 'node', args: ['-e', MOCK_AGENT], cwd: process.cwd() });
    try {
      await client.connect();
      const text = await client.prompt('write hello world');
      expect(text).toBe('mock result for: write hello world');
    } finally {
      client.close();
    }
  });

  it('cancel is a best-effort notification (no throw)', async () => {
    const client = new AcpClient({ command: 'node', args: ['-e', MOCK_AGENT], cwd: process.cwd() });
    try {
      await client.connect();
      expect(() => client.cancel('sess-1')).not.toThrow();
    } finally {
      client.close();
    }
  });

  it('fails clearly on unknown command', async () => {
    const client = new AcpClient({ command: 'definitely-not-a-real-binary-xyz', cwd: process.cwd() });
    await expect(client.connect()).rejects.toThrow(AcpError);
    client.close();
  });

  it('rejects empty command', () => {
    expect(() => new AcpClient({ command: '  ', cwd: process.cwd() })).toThrow(AcpError);
  });

  it('prompt before connect rejects', async () => {
    const client = new AcpClient({ command: 'node', args: ['-e', MOCK_AGENT], cwd: process.cwd() });
    await expect(client.prompt('hi')).rejects.toThrow(/not connected/);
    client.close();
  });

  it('close() SIGKILL-escalates a SIGTERM-ignoring child (M8)', async () => {
    if (process.platform === 'win32') return; // POSIX process groups only
    const dir = await mkdtemp(join(tmpdir(), 'acp-kill-'));
    const pidFile = join(dir, 'child.pid');
    // Speaks just enough protocol for connect(), but ignores SIGTERM.
    const IGNORER = `
      const fs = require('fs');
      fs.writeFileSync(process.env.ACP_TEST_PIDFILE, String(process.pid));
      process.on('SIGTERM', () => {});
      const rl = require('readline').createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        let msg; try { msg = JSON.parse(line); } catch { return; }
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'ignorer' } } }) + '\\n');
        }
      });
    `;
    const client = new AcpClient({ command: 'node', args: ['-e', IGNORER], cwd: process.cwd() });
    process.env.ACP_TEST_PIDFILE = pidFile; // survives connect()'s env scrub (not a secret)
    try {
      const info = await client.connect();
      expect(info.agentName).toBe('ignorer');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).not.toThrow(); // alive before close
      client.close();
      const deadline = Date.now() + 15_000;
      for (;;) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
          else throw e;
        }
        if (!alive) break;
        if (Date.now() > deadline) throw new Error('SIGTERM-ignoring child survived close()');
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      delete process.env.ACP_TEST_PIDFILE;
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('requires an explicit cwd and spawns the child inside it (L4)', async () => {
    // Type-level guarantee: cwd is required, so the client can never
    // silently inherit the ambient working directory. The @ts-expect-error
    // below fails the build if cwd ever becomes optional again.
    const opts: AcpClientOptions = { command: 'node', cwd: process.cwd() };
    expect(opts.cwd).toBe(process.cwd());
    // @ts-expect-error — missing cwd must not compile
    const bad: AcpClientOptions = { command: 'node' };
    void bad;

    // Runtime: the child really runs in the given cwd.
    const dir = await mkdtemp(join(tmpdir(), 'acp-cwd-'));
    try {
      const CWD_REPORTER = `
        const rl = require('readline').createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          let msg; try { msg = JSON.parse(line); } catch { return; }
          if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: process.cwd() } } }) + '\\n');
          }
        });
      `;
      const client = new AcpClient({ command: 'node', args: ['-e', CWD_REPORTER], cwd: dir });
      try {
        const info = await client.connect();
        expect(info.agentName).toBe(dir);
      } finally {
        client.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('acpOptionsFromBot', () => {
  it('returns null when no acp config', () => {
    expect(acpOptionsFromBot(undefined)).toBeNull();
    expect(acpOptionsFromBot({})).toBeNull();
    expect(acpOptionsFromBot({ acp: { command: '  ' } })).toBeNull();
  });

  it('parses command and args', () => {
    expect(acpOptionsFromBot({ acp: { command: 'opencode', args: ['acp', '--x'] } })).toEqual({
      command: 'opencode',
      args: ['acp', '--x'],
    });
  });
});
