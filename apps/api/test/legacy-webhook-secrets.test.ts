// SPDX-License-Identifier: Apache-2.0
// A-1 legacy webhook secret hardening: hash-at-rest migration,
// timing-safe verification against hashes, the migrated HMAC scheme
// (key = sha256hex(secret)), failed-auth journal + failure rate limit
// (with no lockout of the legitimate sender), paused uniformity for
// the routine-trigger surface, and rotation flows. Mocks only,
// localhost only; temp dirs are unique and removed after each test.

import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// Vite cannot resolve a bare 'node:sqlite' import in tests; the
// established idiom in this suite is process.getBuiltinModule.
const { DatabaseSync: DatabaseSyncCtor } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutineStore, RoutineWebhookTriggerStore } from '../src/bot-routines.js';
import { RoutineHookStore, createPublicHookRouter } from '../src/routine-hooks.js';
import { createRoutineWebhookRouter, createScriptWebhookRouter } from '../src/webhooks.js';
import {
  LegacyWebhookAuthGuard,
  hashLegacySecret,
  isHashedLegacySecret,
  verifyPresentedSecret,
  verifySignatureAgainstStored,
} from '../src/legacy-webhook-secrets.js';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';

const bots = [
  { id: 'worker', name: 'Worker', description: 'does work', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
] as unknown as BotConfig[];

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function rawDb(dir: string): DatabaseSync {
  return new DatabaseSyncCtor(join(dir, 'bot-routines.db'));
}

function allTextValues(db: DatabaseSync): string[] {
  const out: string[] = [];
  for (const table of ['bot_routines', 'routine_webhook_triggers']) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as unknown as Array<Record<string, unknown>>;
    for (const row of rows) for (const v of Object.values(row)) if (typeof v === 'string') out.push(v);
  }
  return out;
}

describe('hash-at-rest migration (bot-routines.db)', () => {
  it('migrates plaintext rows in place, is idempotent, and the original secrets still authenticate', () => {
    const dir = tempDir('legacy-migrate-');
    const hookPlain = 'a'.repeat(64);
    const triggerPlain = 'b'.repeat(64);
    // Boot once so the schema exists, then plant PRE-migration plaintext
    // rows exactly as a legacy DB would hold them.
    new RoutineStore(dir);
    const db = rawDb(dir);
    db.prepare(
      `INSERT INTO bot_routines (id, name, bot_id, prompt_template, enabled, created_at, webhook_secret)
       VALUES ('r-legacy', 'legacy', 'worker', 'hi', 1, 1, ?)`,
    ).run(hookPlain);
    db.prepare(
      `INSERT INTO routine_webhook_triggers (id, routine_id, secret, enabled, created_at)
       VALUES ('t-legacy', 'r-legacy', ?, 1, 1)`,
    ).run(triggerPlain);
    db.close();

    // Boot again: the store-layer migration runs in openDb.
    const routineStore = new RoutineStore(dir);
    const triggerStore = new RoutineWebhookTriggerStore(dir);

    const check = rawDb(dir);
    const values = allTextValues(check);
    // (ii) No plaintext secret remains anywhere in the DB.
    expect(values).not.toContain(hookPlain);
    expect(values).not.toContain(triggerPlain);
    expect(values.some((v) => v.includes(hookPlain) || v.includes(triggerPlain))).toBe(false);
    check.close();

    // (i) Rows were migrated to hash form.
    expect(routineStore.getWebhookSecret('r-legacy')).toBe(hashLegacySecret(hookPlain));
    expect(isHashedLegacySecret(triggerStore.get('t-legacy')!.secret)).toBe(true);
    expect(triggerStore.get('t-legacy')!.secret).toBe(hashLegacySecret(triggerPlain));

    // (iii) Auth with the ORIGINAL secrets still succeeds.
    expect(routineStore.verifyWebhookSecret('r-legacy', hookPlain)).toBe(true);
    expect(routineStore.verifyWebhookSecret('r-legacy', 'wrong')).toBe(false);
    expect(triggerStore.verifySecret('t-legacy', triggerPlain)).toBe(true);
    expect(triggerStore.verifySecret('t-legacy', hookPlain)).toBe(false);

    // Idempotent: another boot changes nothing.
    const again = new RoutineStore(dir);
    expect(again.getWebhookSecret('r-legacy')).toBe(hashLegacySecret(hookPlain));
  });

  it('new secrets are stored hashed from creation', () => {
    const dir = tempDir('legacy-create-');
    const routineStore = new RoutineStore(dir);
    const triggerStore = new RoutineWebhookTriggerStore(dir);
    const routine = routineStore.create({ name: 'n', botId: 'worker', promptTemplate: 'x' });
    // The per-routine hook secret exists only as a hash from birth.
    expect(isHashedLegacySecret(routineStore.getWebhookSecret(routine.id))).toBe(true);
    // Trigger create returns the plaintext ONCE; the stored row is the hash.
    const trigger = triggerStore.create(routine.id);
    expect(trigger.secret).toHaveLength(64);
    expect(triggerStore.get(trigger.id)!.secret).toBe(hashLegacySecret(trigger.secret));
    const db = rawDb(dir);
    expect(allTextValues(db)).not.toContain(trigger.secret);
    db.close();
  });
});

describe('verification helpers', () => {
  it('verifyPresentedSecret digest-compares against the stored hash', () => {
    const stored = hashLegacySecret('s3cret-value');
    expect(verifyPresentedSecret('s3cret-value', stored)).toBe(true);
    expect(verifyPresentedSecret('nope', stored)).toBe(false);
    expect(verifyPresentedSecret(undefined, stored)).toBe(false);
    expect(verifyPresentedSecret('s3cret-value', undefined)).toBe(false);
  });

  it('HMAC: new scheme (key = sha256hex(secret)) verifies against the stored hash; old scheme does not', () => {
    const secret = 'c'.repeat(64);
    const stored = hashLegacySecret(secret);
    const body = Buffer.from('{"a":1}');
    const derivedKey = createHash('sha256').update(secret, 'utf8').digest('hex');
    const newSig = 'sha256=' + createHmac('sha256', derivedKey).update(body).digest('hex');
    expect(verifySignatureAgainstStored(newSig, body, stored)).toBe(true);
    // Old scheme: HMAC keyed with the raw secret — the documented break.
    const oldSig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(verifySignatureAgainstStored(oldSig, body, stored)).toBe(false);
    expect(verifySignatureAgainstStored('sha256=zz', body, stored)).toBe(false);
  });
});

describe('failed-auth journal + rate limit (public hook surface)', () => {
  async function setupHook(guard: LegacyWebhookAuthGuard) {
    const dir = tempDir('legacy-hook-rl-');
    const routineStore = new RoutineStore(dir);
    const hookStore = new RoutineHookStore(dir);
    const routine = routineStore.create({ name: 'n', botId: 'worker', promptTemplate: 'x {{payload}}' });
    const secret = routineStore.regenerateWebhookSecret(routine.id);
    const app = express();
    app.use('/api/hooks', express.raw({ type: '*/*', limit: '64kb' }), createPublicHookRouter({ routineStore, hookStore, authGuard: guard }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    return {
      routineStore,
      hookStore,
      routineId: routine.id,
      secret,
      close: () => server.close(),
      post: (path: string, headers: Record<string, string> = {}) =>
        fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: '{}' }),
    };
  }

  it('journals failures, rate-limits further failures with 429, and never locks out valid auth', async () => {
    const guard = new LegacyWebhookAuthGuard({ maxFailuresPerWindow: 3, windowMs: 60_000 });
    const ctx = await setupHook(guard);
    try {
      const bad = () => ctx.post(`/api/hooks/${ctx.routineId}/wrongsecret`);
      expect((await bad()).status).toBe(401);
      expect((await bad()).status).toBe(401);
      // Third failure reaches the budget → 429 instead of 401.
      expect((await bad()).status).toBe(429);
      expect((await bad()).status).toBe(429);
      // Journal holds the failure (writes throttled per IP+target+reason).
      const journal = guard.listAuthJournal(10);
      expect(journal.length).toBeGreaterThanOrEqual(1);
      expect(journal[0]).toMatchObject({ target: ctx.routineId, reason: 'bad_secret_or_signature' });
      // The legitimate sender is NOT locked out by the spray.
      const ok = await ctx.post(`/api/hooks/${ctx.routineId}/${ctx.secret}`);
      expect(ok.status).toBe(202);
    } finally {
      ctx.close();
      ctx.hookStore.close();
    }
  });

  it('rotation: old hook secret dies, fresh secret (shown once) works', async () => {
    const guard = new LegacyWebhookAuthGuard({});
    const ctx = await setupHook(guard);
    try {
      const fresh = ctx.routineStore.regenerateWebhookSecret(ctx.routineId);
      expect(fresh).not.toBe(ctx.secret);
      expect((await ctx.post(`/api/hooks/${ctx.routineId}/${ctx.secret}`)).status).toBe(401);
      expect((await ctx.post(`/api/hooks/${ctx.routineId}/${fresh}`)).status).toBe(202);
      // Bearer form with the fresh secret also works (canonical form).
      const bearer = await ctx.post(`/api/hooks/${ctx.routineId}/anything`, {
        authorization: `Bearer ${fresh}`,
      });
      expect(bearer.status).toBe(202);
    } finally {
      ctx.close();
      ctx.hookStore.close();
    }
  });
});

describe('failed-auth journal + rate limit (routine trigger surface)', () => {
  it('bad secrets journal + 429 after budget; disabled trigger and disabled routine share the 404', async () => {
    const dir = tempDir('legacy-trigger-rl-');
    const routineStore = new RoutineStore(dir);
    const triggerStore = new RoutineWebhookTriggerStore(dir);
    const routine = routineStore.create({ name: 'n', botId: 'worker', promptTemplate: 'x {{payload}}' });
    const trigger = triggerStore.create(routine.id);
    const guard = new LegacyWebhookAuthGuard({ maxFailuresPerWindow: 2, windowMs: 60_000 });
    const agentRuntime = { runTurn: vi.fn(async () => ({})) } as unknown as AgentRuntime;
    const app = express();
    app.use(express.json());
    app.use(
      '/webhooks/routines',
      createRoutineWebhookRouter({ routineStore, triggerStore, agentRuntime, getBots: () => bots, authGuard: guard }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    const post = (id: string, secret: string) =>
      fetch(`http://127.0.0.1:${port}/webhooks/routines/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-secret': secret },
        body: '{}',
      });
    try {
      expect((await post(trigger.id, 'wrong')).status).toBe(401);
      expect((await post(trigger.id, 'wrong')).status).toBe(429);
      expect(guard.listAuthJournal(10).some((e) => e.target === trigger.id && e.reason === 'bad_secret')).toBe(true);
      // Valid secret still accepted despite the failure spray.
      expect((await post(trigger.id, trigger.secret)).status).toBe(202);
      // Uniform 404s: unknown trigger, then disabled routine.
      expect((await post('nope', 'x')).status).toBe(404);
      routineStore.update(routine.id, { enabled: false });
      expect((await post(trigger.id, trigger.secret)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('script webhook surface (config-supplied secrets)', () => {
  it('config secrets stay config-side; failed auth journals + rate-limits, valid secret still fires', async () => {
    const guard = new LegacyWebhookAuthGuard({ maxFailuresPerWindow: 2, windowMs: 60_000 });
    const app = express();
    app.use(express.json());
    app.use(
      '/webhooks',
      createScriptWebhookRouter({
        hooks: [{ kind: 'script', command: ['true'], events: [], name: 'deploy' }],
        secrets: { deploy: 'config-secret-123' },
        runHook: async () => ({ injections: [], errors: [] }),
        authGuard: guard,
      }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.on('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    const post = (secret?: string) =>
      fetch(`http://127.0.0.1:${port}/webhooks/script/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(secret ? { 'x-webhook-secret': secret } : {}) },
        body: '{}',
      });
    try {
      expect((await post('wrong')).status).toBe(401);
      expect((await post('wrong')).status).toBe(429);
      expect(guard.listAuthJournal(10).some((e) => e.target === 'script:deploy')).toBe(true);
      expect((await post('config-secret-123')).status).toBe(202);
    } finally {
      server.close();
    }
  });
});
