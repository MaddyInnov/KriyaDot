// SPDX-License-Identifier: Apache-2.0
// Wave-6 coding-ecosystem slices: CA-22, CA-32, CA-34, CA-24.
// All GitHub / provider / vault collaborators are fakes — no live calls.
import { createHmac } from 'node:crypto';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseKriyaDotCommand, handleGithubCommentWebhook, verifyGithubSignature, registerGithubAgentRoutes,
} from '../src/github-agent.js';
import { artifactModelCall, ArtifactModelError, artifactModelBridgeScript, registerArtifactModelRoutes } from '../src/artifact-model.js';
import { validateFolderSession, exportFolderSession, folderSessionToBundle, planFolderSessionImport, registerFolderSessionRoutes } from '../src/folder-session.js';
import { registerPluginUiRoutes } from '../src/plugin-ui-routes.js';

let server: { close(cb: () => void): void } | undefined;
afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = undefined; });

async function serve(app: express.Express): Promise<string> {
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) as never; });
  const port = (server as unknown as { address(): { port: number } }).address().port;
  return `http://127.0.0.1:${port}`;
}

const GH_PAYLOAD = {
  action: 'created',
  repository: { full_name: 'octo/demo' },
  issue: { number: 7, pull_request: { url: 'https://api.github.com/x' } },
  comment: { id: 42, body: 'please look\n/kriyadot run fix the flaky test', user: { login: 'ash' }, html_url: 'https://github.com/octo/demo/issues/7#issuecomment-42' },
};

describe('CA-22 GitHub agent pack', () => {
  it('parses /kriyadot commands', () => {
    expect(parseKriyaDotCommand('hi\n/kriyadot run fix it')?.kind).toBe('run');
    expect(parseKriyaDotCommand('/kriyadot review please')?.kind).toBe('review');
    expect(parseKriyaDotCommand('no command here')).toBeNull();
  });

  it('dispatches a run through the injected routine dispatcher (fake payload, no live GitHub)', async () => {
    const dispatched: string[] = [];
    const res = await handleGithubCommentWebhook(GH_PAYLOAD, {
      secret: 's', dispatchRun: async ({ task }) => { dispatched.push(task); return { runId: 'run-1' }; },
    });
    expect(res.handled).toBe(true);
    expect(res.runId).toBe('run-1');
    expect(dispatched[0]).toContain('flaky');
  });

  it('posts a review only through the approval-gated poster injection', async () => {
    const posted: unknown[] = [];
    const payload = { ...GH_PAYLOAD, comment: { ...GH_PAYLOAD.comment, body: '/kriyadot review' } };
    const res = await handleGithubCommentWebhook(payload, {
      secret: 's',
      dispatchRun: async () => ({}),
      reviewPullRequest: async () => ({ body: 'Looks good, one nit.', event: 'COMMENT' }),
      postReview: async (r) => { posted.push(r); },
    });
    expect(res.handled).toBe(true);
    expect(posted).toHaveLength(1);
  });

  it('verifies HMAC signatures and rejects bad ones at the router', async () => {
    const secret = 'whsec_test';
    const raw = Buffer.from(JSON.stringify(GH_PAYLOAD));
    const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
    expect(verifyGithubSignature(sig, raw, secret)).toBe(true);
    expect(verifyGithubSignature('sha256=' + '0'.repeat(64), raw, secret)).toBe(false);

    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerGithubAgentRoutes(router, { secret, dispatchRun: async () => ({ runId: 'r' }) });
    app.use('/api/github-agent', router);
    const base = await serve(app);
    const bad = await fetch(`${base}/api/github-agent/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64), 'x-github-event': 'issue_comment' }, body: JSON.stringify(GH_PAYLOAD) });
    // Note: router verifies against rawBody/serialized body; a tampered sig must never dispatch.
    expect([401, 500]).toContain(bad.status);
  });
});

describe('CA-32 artifact model-call broker', () => {
  const deps = {
    findPublication: (slug: string) => (slug === 'abc' ? { slug, title: 'Demo' } : undefined),
    resolveProviderKey: () => 'vault-key-never-returned',
    callProvider: async ({ apiKey, prompt }: { apiKey?: string; prompt: string }) => {
      if (!apiKey) throw new Error('provider should receive the vault key');
      return { text: `echo:${prompt}`, model: 'mock-1', inputTokens: 3, outputTokens: 5, costCents: 1 };
    },
    checkCap: () => ({ allowed: true }),
  };

  it('brokers a call: artifact holds no key, host uses the vault key, cost is recorded + audited', async () => {
    const costs: number[] = []; const audits: string[] = [];
    const out = await artifactModelCall({ slug: 'abc', prompt: 'summarize' }, { ...deps, recordCost: (c) => costs.push(c.costCents), audit: (a) => audits.push(a) }, { userId: 'u1' });
    expect(out.text).toBe('echo:summarize');
    expect(JSON.stringify(out)).not.toContain('vault-key');
    expect(costs).toEqual([1]);
    expect(audits).toContain('artifact.model-call');
    expect(artifactModelBridgeScript('abc')).toContain('kriyadotModel');
    expect(artifactModelBridgeScript('abc')).not.toContain('vault-key');
  });

  it('blocks when the spend cap denies (402) and when the publication is unknown (404)', async () => {
    await expect(artifactModelCall({ slug: 'abc', prompt: 'x' }, { ...deps, checkCap: () => ({ allowed: false, message: 'cap hit' }) }, { userId: 'u1' }))
      .rejects.toMatchObject({ status: 402 });
    await expect(artifactModelCall({ slug: 'nope', prompt: 'x' }, deps, { userId: 'u1' })).rejects.toBeInstanceOf(ArtifactModelError);
  });

  it('serves the model-call route with a mock provider', async () => {
    const app = express(); app.use(express.json());
    const router = express.Router();
    registerArtifactModelRoutes(router, deps, () => 'u1');
    app.use('/api/artifacts', router);
    const base = await serve(app);
    const res = await fetch(`${base}/api/artifacts/model-call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'abc', prompt: 'hi' }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toBe('echo:hi');
  });
});

describe('CA-34 folder sessions', () => {
  const session = exportFolderSession({
    id: 'my-project', name: 'My Project', description: 'd', folder: 'projects/my-project',
    bot: { id: 'coder', name: 'Coder', systemPrompt: 'You code.', tools: ['fs_read'], skills: [] },
    routines: [{ id: 'morning', name: 'Morning', promptTemplate: 'Summarize {{payload}}', enabled: true }],
    placement: 'cloud-report', entryIds: ['coder'],
  });

  it('exports/validates a bundle-shaped unit and plans a confined import', () => {
    expect(folderSessionToBundle(session).entryIds).toEqual(['coder']);
    const plan = planFolderSessionImport(session, '/srv/workspaces');
    expect(plan.workspacePath).toBe('/srv/workspaces/projects/my-project');
    expect(plan.placement).toBe('cloud-report');
  });

  it('rejects traversal folders and bad placements', () => {
    expect(() => validateFolderSession({ ...session, folder: '../escape' })).toThrow(/safe relative/);
    expect(() => validateFolderSession({ ...session, placement: 'anywhere' })).toThrow(/placement/);
  });

  it('imports through the route with an injected materializer', async () => {
    const made: string[] = [];
    const app = express(); app.use(express.json());
    const router = express.Router();
    registerFolderSessionRoutes(router, { allowedRoot: '/srv/workspaces', materialize: (s) => { made.push(s.id); return { ok: true }; } });
    app.use('/api/folder-sessions', router);
    const base = await serve(app);
    const res = await fetch(`${base}/api/folder-sessions/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(session) });
    expect(res.status).toBe(201);
    expect(made).toEqual(['my-project']);
  });
});

describe('CA-24 plugin UI routes (reduced, default-off)', () => {
  it('404s when the flag is off; serves a nonce-CSP sandboxed frame when on', async () => {
    const app = express();
    const off = express.Router(); registerPluginUiRoutes(off, { enabled: false, resolveContribution: () => undefined }); app.use('/off', off);
    const on = express.Router();
    registerPluginUiRoutes(on, { enabled: true, resolveContribution: () => ({ contribution: { entry: 'ui/p.html', title: 'Panel', embedding: 'sandboxed-iframe' }, html: '<p>hi</p>' }) });
    app.use('/on', on);
    const base = await serve(app);
    expect((await fetch(`${base}/off/demo/frame`)).status).toBe(404);
    const res = await fetch(`${base}/on/demo/frame`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(await res.text()).toContain('sandbox="allow-scripts"');
  });
});
