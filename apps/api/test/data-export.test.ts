// SPDX-License-Identifier: Apache-2.0
// DA-1 — one-shot data export: archive contents per category, secret
// exclusion discipline, manifest checksums, and the FL-7 expiring link.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataExportService, createDataExportRouter } from '../src/data-export.js';
import { FileLinkService } from '../src/file-links.js';

describe('DataExportService (DA-1)', () => {
  let dir: string;
  let dataDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'data-export-'));
    dataDir = join(dir, 'data');
    workspaceDir = join(dir, 'workspace');
    mkdirSync(join(dataDir, 'omni-memory'), { recursive: true });
    mkdirSync(join(workspaceDir, 'notes'), { recursive: true });
    writeFileSync(join(dataDir, 'bot-conversations.db'), 'fake-transcripts');
    writeFileSync(join(dataDir, 'recordings.db'), 'fake-recordings');
    writeFileSync(join(dataDir, 'omni.db'), 'fake-memory');
    writeFileSync(join(dataDir, 'omni-memory', 'fact.md'), 'remembered fact');
    writeFileSync(join(dataDir, 'preferences.db'), 'fake-settings');
    writeFileSync(join(dataDir, 'vault.json'), JSON.stringify({ secrets: ['sk-never-export'] }));
    writeFileSync(join(workspaceDir, 'notes', 'todo.md'), '# tasks\n');
    writeFileSync(join(workspaceDir, 'api-token.txt'), 'should-be-excluded');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds one archive with every category, a manifest, and an expiring link', async () => {
    const service = new DataExportService({ dataDir, workspaceDir });
    const result = await service.createExport({ confirmed: true });

    expect(result.archivePath).toMatch(/^exports\/kriyadot-export-.*\.zip$/);
    expect(existsSync(join(workspaceDir, result.archivePath))).toBe(true);
    expect(result.link.status).toBe('active');
    expect(result.linkPath).toBe(`/f/${result.linkToken}`);

    const zip = await JSZip.loadAsync(readFileSync(join(workspaceDir, result.archivePath)));
    const names = Object.keys(zip.files);
    expect(names).toContain('export-manifest.json');
    expect(names).toContain('transcripts/bot-conversations.db');
    expect(names).toContain('recordings/recordings.db');
    expect(names).toContain('memory/omni.db');
    expect(names).toContain('memory/omni-memory/fact.md');
    expect(names).toContain('settings/preferences.db');
    expect(names).toContain('files/notes/todo.md');

    // Secrets never enter the archive; exclusions are listed instead.
    expect(names.some((n) => n.includes('vault'))).toBe(false);
    expect(names.some((n) => n.includes('api-token'))).toBe(false);
    const manifest = JSON.parse(await zip.file('export-manifest.json')!.async('string')) as {
      format: string;
      categories: string[];
      files: Array<{ path: string; sha256: string }>;
      excluded: Array<{ path: string }>;
    };
    expect(manifest.format).toBe('kriyadot.data-export');
    expect(manifest.categories).toEqual(['transcripts', 'files', 'recordings', 'memory', 'settings']);
    expect(manifest.excluded.map((e) => e.path)).toContain('files/api-token.txt');
    const transcript = manifest.files.find((f) => f.path === 'transcripts/bot-conversations.db');
    expect(transcript?.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The link resolves through the FL-7 service to the archive file.
    const links = new FileLinkService(dataDir);
    expect(links.list().some((l) => l.id === result.link.id && l.relPath === result.archivePath)).toBe(true);
  });

  it('respects a category subset', async () => {
    const service = new DataExportService({ dataDir, workspaceDir });
    const result = await service.createExport({ categories: ['files'], confirmed: true });
    expect(result.manifest.categories).toEqual(['files']);
    expect(result.manifest.files.every((f) => f.category === 'files')).toBe(true);
  });

  it('refuses to mint a link without confirmation when no governance gateway is wired', async () => {
    const service = new DataExportService({ dataDir, workspaceDir });
    await expect(service.createExport({})).rejects.toThrow(/approval|confirm/i);
  });

  it('serves the export over HTTP with the download path', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createDataExportRouter({ dataDir, workspaceDir }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/data-export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { ok: boolean; downloadPath: string; archivePath: string };
      expect(body.ok).toBe(true);
      expect(body.downloadPath).toMatch(/^\/f\//);
      expect(existsSync(join(workspaceDir, body.archivePath))).toBe(true);

      const refused = await fetch(`http://127.0.0.1:${port}/api/data-export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(refused.status).toBe(403);
    } finally {
      server.close();
    }
  });
});
