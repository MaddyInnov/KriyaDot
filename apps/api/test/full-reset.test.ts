// SPDX-License-Identifier: Apache-2.0
// DA-2 — full reset: type-to-confirm gate, active-turn refusal + force,
// enumerated wipe, audit tombstone survival.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FULL_RESET_CONFIRM_PHRASE,
  FullResetError,
  FullResetService,
  RESET_TOMBSTONE_NAME,
  createFullResetRouter,
} from '../src/full-reset.js';
import { LifecycleAuditLog } from '../src/lifecycle-approval.js';

describe('FullResetService (DA-2)', () => {
  let dir: string;
  let dataDir: string;
  let workspaceDir: string;
  let uploadsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'full-reset-'));
    dataDir = join(dir, 'data');
    workspaceDir = join(dir, 'workspace');
    uploadsDir = join(dataDir, 'uploads');
    mkdirSync(uploadsDir, { recursive: true });
    mkdirSync(join(workspaceDir, 'docs'), { recursive: true });
    writeFileSync(join(dataDir, 'bot-conversations.db'), 'chats');
    writeFileSync(join(dataDir, 'chat-threads.db'), 'threads');
    writeFileSync(join(dataDir, 'tasks.json'), '[]');
    writeFileSync(join(dataDir, 'chat-queue.db'), 'queue');
    writeFileSync(join(dataDir, 'vault.json'), 'keep-me');
    writeFileSync(join(dataDir, 'bot-routines.db'), 'keep-me-too');
    writeFileSync(join(workspaceDir, 'docs', 'a.md'), 'hello');
    writeFileSync(join(uploadsDir, 'upload-1.bin'), 'upload');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses without the exact confirm phrase and wipes nothing', () => {
    const service = new FullResetService({ dataDir, workspaceDir });
    expect(() => service.reset({ confirmText: 'reset my data' })).toThrow(FullResetError);
    expect(() => service.reset({})).toThrow(/confirmText/);
    expect(existsSync(join(dataDir, 'bot-conversations.db'))).toBe(true);
    expect(existsSync(join(workspaceDir, 'docs', 'a.md'))).toBe(true);
  });

  it('refuses while turns are active unless forced', () => {
    const service = new FullResetService({ dataDir, workspaceDir, activeTurns: () => 2 });
    expect(() => service.reset({ confirmText: FULL_RESET_CONFIRM_PHRASE })).toThrow(/2 turn\(s\) are active/);
    expect(existsSync(join(dataDir, 'tasks.json'))).toBe(true);
    const receipt = service.reset({ confirmText: FULL_RESET_CONFIRM_PHRASE, force: true });
    expect(receipt.forced).toBe(true);
    expect(existsSync(join(dataDir, 'tasks.json'))).toBe(false);
  });

  it('wipes chats, files and active tasks — and only those — leaving a tombstone + audit', () => {
    const auditLog = new LifecycleAuditLog(dataDir);
    const service = new FullResetService({ dataDir, workspaceDir, auditLog });
    const receipt = service.reset({ confirmText: FULL_RESET_CONFIRM_PHRASE, actor: 'test' });

    expect(receipt.removedStores).toEqual(
      expect.arrayContaining(['bot-conversations.db', 'chat-threads.db', 'tasks.json', 'chat-queue.db']),
    );
    expect(existsSync(join(dataDir, 'bot-conversations.db'))).toBe(false);
    expect(existsSync(join(dataDir, 'chat-queue.db'))).toBe(false);
    expect(existsSync(uploadsDir)).toBe(false);
    expect(existsSync(join(workspaceDir, 'docs'))).toBe(false);

    // Out-of-scope stores survive: this is a data reset, not an uninstall.
    expect(existsSync(join(dataDir, 'vault.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'bot-routines.db'))).toBe(true);

    const tombstone = JSON.parse(readFileSync(join(dataDir, RESET_TOMBSTONE_NAME), 'utf8')) as {
      kind: string;
      actor: string;
    };
    expect(tombstone.kind).toBe('kriyadot.full-reset-tombstone');
    expect(tombstone.actor).toBe('test');
    expect(auditLog.list().some((e) => e.action === 'data.full_reset')).toBe(true);
  });

  it('preview reports scope without deleting anything', () => {
    const service = new FullResetService({ dataDir, workspaceDir, activeTurns: () => 1 });
    const preview = service.preview();
    expect(preview.stores).toContain('bot-conversations.db');
    expect(preview.workspaceEntries).toContain('docs');
    expect(preview.activeTurns).toBe(1);
    expect(existsSync(join(dataDir, 'bot-conversations.db'))).toBe(true);
  });

  it('serves preview + reset over HTTP with the right status codes', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createFullResetRouter({ dataDir, workspaceDir, activeTurns: () => 1 }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/api/full-reset`;
    try {
      const preview = await (await fetch(`${base}/preview`)).json() as { confirmPhrase: string };
      expect(preview.confirmPhrase).toBe(FULL_RESET_CONFIRM_PHRASE);

      const wrongPhrase = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmText: 'yes' }),
      });
      expect(wrongPhrase.status).toBe(400);

      const blocked = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmText: FULL_RESET_CONFIRM_PHRASE }),
      });
      expect(blocked.status).toBe(409);

      const forced = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmText: FULL_RESET_CONFIRM_PHRASE, force: true }),
      });
      expect(forced.status).toBe(200);
      expect(existsSync(join(dataDir, RESET_TOMBSTONE_NAME))).toBe(true);
    } finally {
      server.close();
    }
  });
});
