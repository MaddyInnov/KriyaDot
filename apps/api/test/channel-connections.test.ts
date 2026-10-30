// SPDX-License-Identifier: Apache-2.0
// Tests for the unified secure connect flow + status surface (CH-2/CH-3):
// - begin → complete stores credentials ONLY via the injected encrypted
//   store hooks; the service's own state file contains no secret material
// - flows are single-use and expire; a failed probe rolls the credential back
// - status surface lists every provider with no credential material
// - disconnect removes the credential and clears status

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelConnectionService } from '../src/channel-connections.js';
import type { ProviderKeyInput } from '../src/providers.js';

describe('ChannelConnectionService', () => {
  let dir: string;
  let saved: Map<string, ProviderKeyInput>;
  let removed: string[];
  let service: ChannelConnectionService;
  let now = 5_000_000;

  function makeService(probe?: (id: string) => Promise<{ ok: boolean; detail?: string }>): ChannelConnectionService {
    return new ChannelConnectionService({
      dataDir: dir,
      saveKey: (ref, input) => { saved.set(ref, input); },
      removeKey: (ref) => { removed.push(ref); return saved.delete(ref); },
      ...(probe ? { probe } : {}),
      now: () => now,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chanconn-'));
    saved = new Map();
    removed = [];
    service = makeService();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists every provider as disconnected initially, with no secret fields (CH-3)', () => {
    const list = service.listConnections();
    expect(list.map((c) => c.providerId)).toEqual(['whatsapp', 'telegram', 'discord', 'slack', 'email']);
    expect(list.every((c) => c.status === 'disconnected')).toBe(true);
    for (const entry of list) {
      expect(Object.keys(entry)).not.toContain('apiKey');
      expect(Object.keys(entry)).not.toContain('token');
    }
  });

  it('completes the unified flow: credential stored via saveKey only, status connected (CH-2)', async () => {
    const begun = service.beginConnect('whatsapp');
    expect(begun.steps.length).toBeGreaterThan(0);
    const done = await service.completeConnect(begun.flowId, {
      credentials: { apiKey: 'wa-token-xyz' },
      settings: { phoneNumberId: 'pn-42' },
    });
    expect(done.status).toBe('connected');
    expect(done.webhookSecret.length).toBeGreaterThan(10);
    expect(saved.get('custom-whatsapp')?.apiKey).toBe('wa-token-xyz');
    expect(saved.get('custom-whatsapp-webhook')?.apiKey).toBe(done.webhookSecret);
    const status = service.listConnections().find((c) => c.providerId === 'whatsapp');
    expect(status).toMatchObject({ status: 'connected', settings: { phoneNumberId: 'pn-42' }, hasWebhookSecret: true });
    // The service's own state file must contain NO credential material.
    const fileRaw = readFileSync(join(dir, 'channel-connections.json'), 'utf8');
    expect(fileRaw).not.toContain('wa-token-xyz');
    expect(fileRaw).not.toContain(done.webhookSecret);
  });

  it('flows are single-use and expire', async () => {
    const begun = service.beginConnect('telegram');
    await service.completeConnect(begun.flowId, { credentials: { apiKey: 'tg' } });
    await expect(service.completeConnect(begun.flowId, { credentials: { apiKey: 'tg' } })).rejects.toThrow(/already used/);

    const begun2 = service.beginConnect('telegram');
    now += 11 * 60 * 1000;
    await expect(service.completeConnect(begun2.flowId, { credentials: { apiKey: 'tg' } })).rejects.toThrow(/expired/);
    expect(() => service.beginConnect('nope')).toThrow(/Unknown messaging provider/);
    await expect(service.completeConnect('missing-flow', { credentials: {} })).rejects.toThrow(/Unknown connect flow/);
  });

  it('requires the descriptor credential + setting fields and marks error', async () => {
    const begun = service.beginConnect('whatsapp');
    await expect(service.completeConnect(begun.flowId, { credentials: {}, settings: {} })).rejects.toThrow(/is required/);
    expect(service.listConnections().find((c) => c.providerId === 'whatsapp')?.status).toBe('error');
    expect(saved.has('custom-whatsapp')).toBe(false);
  });

  it('a failed probe rolls the credential back — nothing half-connected', async () => {
    service = makeService(async () => ({ ok: false, detail: '401 from provider' }));
    const begun = service.beginConnect('discord');
    await expect(
      service.completeConnect(begun.flowId, { credentials: { apiKey: 'bad' }, settings: { botUserId: 'b1' } }),
    ).rejects.toThrow(/Provider check failed/);
    expect(saved.has('custom-discord')).toBe(false);
    expect(removed).toContain('custom-discord');
    expect(service.listConnections().find((c) => c.providerId === 'discord')?.status).toBe('error');
  });

  it('a passing probe connects; disconnect removes credential + clears status (CH-3)', async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    service = makeService(probe);
    const begun = service.beginConnect('slack');
    await service.completeConnect(begun.flowId, { credentials: { apiKey: 'xoxb-1' } });
    expect(probe).toHaveBeenCalledWith('slack');
    const out = service.disconnect('slack');
    expect(out).toEqual({ providerId: 'slack', removedCredential: true });
    expect(saved.has('custom-slack')).toBe(false);
    expect(service.listConnections().find((c) => c.providerId === 'slack')?.status).toBe('disconnected');
    expect(() => service.disconnect('nope')).toThrow(/Unknown messaging provider/);
  });

  it('keeps a Slack signing secret out of the metadata settings', async () => {
    const begun = service.beginConnect('slack');
    await service.completeConnect(begun.flowId, {
      credentials: { apiKey: 'xoxb-1' },
      settings: { signingSecret: 'sign-secret-1' },
    });
    const status = service.listConnections().find((c) => c.providerId === 'slack');
    expect(JSON.stringify(status)).not.toContain('sign-secret-1');
    expect(saved.get('custom-slack-signing')?.apiKey).toBe('sign-secret-1');
    const fileRaw = readFileSync(join(dir, 'channel-connections.json'), 'utf8');
    expect(fileRaw).not.toContain('sign-secret-1');
  });
});
