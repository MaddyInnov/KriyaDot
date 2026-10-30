// SPDX-License-Identifier: Apache-2.0
// #153/#171 (API side): tap installs, workflow-manifest installs with
// SHA-256 verification, portable specialist publish + install-from-
// manifest. Fake fetch only — no network. Uses the REAL marketplace
// installer on a tmp dir.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTapRouter } from '../src/tap-routes.js';
import { MarketplaceInstaller, type MarketplaceEntry } from '@mvp/marketplace';
import { serializeWorkflow, type WorkflowDefinition } from '@mvp/workflows';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const botEntry = (id: string): MarketplaceEntry => ({
  id, kind: 'bot', name: 'Helper', version: '1.0.0', creator: 'test', description: 'd',
  license: 'Apache-2.0', priceCents: 0, tags: [], untrusted: false,
  payload: { id, name: 'Helper', description: 'bot', systemPrompt: 'help', provider: 'mock', model: 'm', skills: [], tools: [], mcpServers: [] },
} as MarketplaceEntry);

const skillEntry = (id: string): MarketplaceEntry => ({
  id, kind: 'skill', name: id, version: '1.0.0', creator: 'test', description: 'd',
  license: 'Apache-2.0', priceCents: 0, tags: [], untrusted: false,
  payload: { id, content: `# ${id}\n` },
} as MarketplaceEntry);

const wfDef: WorkflowDefinition = {
  id: 'wf-t', name: 'Tap WF',
  nodes: [{ id: 'a', type: 'trigger', name: 'A', config: {} }],
  edges: [],
} as WorkflowDefinition;
const wfText = serializeWorkflow(wfDef);

let dir: string;
let base: string;
let server: { close(cb: () => void): void } | null = null;
const installedWorkflows: unknown[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tap-'));
  installedWorkflows.length = 0;
  const installer = new MarketplaceInstaller(join(dir, 'marketplace'));
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createTapRouter({
    installer, dataDir: dir,
    fetchText: async (url) => {
      if (url.includes('wf.json')) return wfText;
      return JSON.stringify({ name: 'tap', entries: [skillEntry('tap-skill')] });
    },
    saveWorkflow: (def) => { installedWorkflows.push(def); },
    publishedBotEntry: (id) => (id === 'bot-x' ? botEntry('bot-x') : undefined),
  }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) as never; });
  base = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/api`;
});

afterEach(async () => {
  await new Promise<void>((r) => server!.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('tap + portable specialist routes', () => {
  it('installs entries from a github tap ref (fake fetch)', async () => {
    const res = await post('/taps/install', { ref: 'owner/repo' });
    expect(res.status).toBe(201);
    const body = await res.json() as { report: { installed: Array<{ id: string }>; errors: string[] } };
    expect(body.report.errors).toEqual([]);
    expect(body.report.installed).toHaveLength(1);
    expect(JSON.stringify(body.report.installed)).toContain('tap-skill');
    expect((await post('/taps/install', {})).status).toBe(400);
  });

  it('installs a workflow package only when the SHA-256 matches', async () => {
    const good = await post('/taps/workflows/install', { packageUrl: 'https://x.invalid/wf.json', sha256: sha(wfText) });
    expect(good.status).toBe(201);
    expect(installedWorkflows).toHaveLength(1);
    const bad = await post('/taps/workflows/install', { packageUrl: 'https://x.invalid/wf.json', sha256: sha('tampered') });
    expect(bad.status).toBe(400);
    expect(installedWorkflows).toHaveLength(1);
  });

  it('publishes a portable specialist manifest and installs from it (checksum-verified, no org scope)', async () => {
    const pub = await post('/specialists/publish', { entry: botEntry('spec-1') });
    expect(pub.status).toBe(201);
    const body = await pub.json() as { manifest: Record<string, unknown>; serialized: string };
    expect(body.manifest.format).toBe('kriyadot-portable@1');
    const inst = await post('/specialists/install-manifest', { manifest: body.serialized });
    expect(inst.status).toBe(201);
    expect(((await inst.json()) as { installed: number }).installed).toBe(1);
    const tampered = body.serialized.replace('Helper', 'Evil!!');
    expect((await post('/specialists/install-manifest', { manifest: tampered })).status).toBe(400);
  });

  it('exports a published bot as a portable manifest', async () => {
    const res = await post('/published-bots/bot-x/export-manifest', {});
    expect(res.status).toBe(200);
    const body = await res.json() as { manifest: { format: string } };
    expect(body.manifest.format).toBe('kriyadot-portable@1');
    expect((await post('/published-bots/ghost/export-manifest', {})).status).toBe(404);
  });
});
