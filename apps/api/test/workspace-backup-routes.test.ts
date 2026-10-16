// SPDX-License-Identifier: Apache-2.0
// Route-level tests for the workspace backup router: download headers,
// dry-run/restore/rollback flow, confirm-required, audit events.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceBackupRouter } from '../src/workspace-backup-routes.js';

describe('workspace backup routes', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let audits: Array<{ action: string; fields: unknown }>;
  let dataDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ws-backup-routes-'));
    dataDir = join(dir, 'data');
    workspaceDir = join(dir, 'workspace');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(dataDir, 'notes.json'), JSON.stringify({ notes: [] }));
    writeFileSync(join(dataDir, 'vault.json'), JSON.stringify({ secrets: [{ value: 'sk-fake' }] }));
    writeFileSync(join(workspaceDir, 'todo.md'), '# tasks\n');
    audits = [];

    const app = express();
    app.use(express.json({ limit: '150mb' }));
    app.use(
      '/api/workspace',
      createWorkspaceBackupRouter({
        dataDir,
        workspaceDir,
        audit: (action, fields) => {
          audits.push({ action, fields });
        },
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as {
        close(cb: () => void): void;
      };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/workspace`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res;
  }

  it('downloads a zip backup with the right filename', async () => {
    const res = await post('/backup', {});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="kriyadot-backup-.*\.zip"/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 2).toString('latin1')).toBe('PK'); // zip magic
    expect(audits.some((a) => a.action === 'workspace.backup_created')).toBe(true);
  });

  it('dry-run → restore requires confirm → rollback works end to end', async () => {
    const backup = Buffer.from(await (await post('/backup', {})).arrayBuffer()).toString('base64');

    const dry = await post('/restore/dry-run', { archive: backup });
    expect(dry.status).toBe(200);
    const dryJson = (await dry.json()) as { ok: boolean; diff: { totals: { unchanged: number } } };
    expect(dryJson.ok).toBe(true);
    expect(dryJson.diff.totals.unchanged).toBeGreaterThan(0);

    // Break a file, then restore without confirm → 400.
    writeFileSync(join(workspaceDir, 'todo.md'), '# broken\n');
    expect((await post('/restore', { archive: backup })).status).toBe(400);

    // With confirm → applied + snapshot.
    const applied = await post('/restore', { archive: backup, confirm: true });
    expect(applied.status).toBe(200);
    const appliedJson = (await applied.json()) as { ok: boolean; snapshot: string };
    expect(appliedJson.ok).toBe(true);
    expect(readFileSync(join(workspaceDir, 'todo.md'), 'utf8')).toBe('# tasks\n');
    expect(audits.some((a) => a.action === 'workspace.restored')).toBe(true);

    // Snapshots listed, rollback restores.
    const list = await (await fetch(`${baseUrl}/backups`)).json() as {
      ok: boolean;
      snapshots: { name: string }[];
    };
    expect(list.snapshots.map((s) => s.name)).toContain(appliedJson.snapshot);
    writeFileSync(join(workspaceDir, 'todo.md'), '# broken again\n');
    const rb = await post('/restore/rollback', { snapshot: appliedJson.snapshot });
    expect(rb.status).toBe(200);
    expect(readFileSync(join(workspaceDir, 'todo.md'), 'utf8')).toBe('# broken\n');
    expect(audits.some((a) => a.action === 'workspace.rollback')).toBe(true);
  });

  it('rejects invalid archives and unknown snapshots', async () => {
    const dry = await post('/restore/dry-run', { archive: Buffer.from('nope').toString('base64') });
    expect(dry.status).toBe(400);
    const rb = await post('/restore/rollback', { snapshot: 'nope.zip' });
    expect(rb.status).toBe(400);
  });
});
