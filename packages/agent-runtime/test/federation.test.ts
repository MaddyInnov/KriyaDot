// SPDX-License-Identifier: Apache-2.0
// Unit tests for federation.ts: identity persistence, envelope signing /
// verification, replay protection, invite + handshake state, tunnel policy
// and the home-authoritative session stubs.

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FederationError,
  FederationService,
  ReplayGuard,
  canonicalJson,
  defaultTunnelPolicy,
  ed25519Sign,
  ed25519Verify,
  instanceIdForPublicKey,
} from '../src/federation.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'federation-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function service(name: string, file = 'fed.json', extra: Partial<ConstructorParameters<typeof FederationService>[0]> = {}): FederationService {
  return new FederationService({ storePath: join(dir, file), name, publicUrl: `http://127.0.0.1:1/api/federation`, ...extra });
}

describe('canonicalJson', () => {
  it('sorts keys recursively and is stable', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
    expect(canonicalJson({ a: 1 })).toBe(canonicalJson({ a: 1 }));
  });
});

describe('ed25519 helpers', () => {
  it('sign/verify round-trips and rejects tampering', () => {
    const a = service('A');
    const id = a.identity();
    const env = a.signEnvelope({ hello: 'world' });
    expect(ed25519Verify(id.publicKey, `${env.timestamp}.${env.nonce}.${canonicalJson(env.body)}`, env.signature)).toBe(true);
    expect(ed25519Verify(id.publicKey, 'tampered', env.signature)).toBe(false);
    expect(instanceIdForPublicKey(id.publicKey)).toBe(id.instanceId);
    expect(typeof ed25519Sign).toBe('function');
  });
});

describe('identity persistence', () => {
  it('generates the keypair once and reuses it across instances', () => {
    const a1 = service('A');
    const a2 = service('A-renamed');
    expect(a2.identity().instanceId).toBe(a1.identity().instanceId);
    expect(a2.identity().publicKey).toBe(a1.identity().publicKey);
    // Store is written owner-only.
    expect(statSync(join(dir, 'fed.json')).mode & 0o077).toBe(0);
    const raw = JSON.parse(readFileSync(join(dir, 'fed.json'), 'utf8')) as { identity: { privateKey: string } };
    expect(raw.identity.privateKey.length).toBeGreaterThan(20);
  });
});

describe('envelope verification + replay', () => {
  it('accepts a fresh envelope and rejects its replay', () => {
    const a = service('A');
    const b = service('B', 'b.json');
    const env = a.signEnvelope({ x: 1 });
    expect(b.verifyEnvelope(env, a.identity().publicKey)).toBe(true);
    // Same envelope again = replayed nonce.
    expect(b.verifyEnvelope(env, a.identity().publicKey)).toBe(false);
  });

  it('rejects a tampered body and a stale timestamp', () => {
    const a = service('A');
    const b = service('B', 'b.json');
    const env = a.signEnvelope({ x: 1 });
    expect(b.verifyEnvelope({ ...env, body: { x: 2 } }, a.identity().publicKey)).toBe(false);
    const stale = { ...env, timestamp: Date.now() - 60 * 60 * 1000 };
    // Re-sign the stale envelope so only the window check can fail it.
    const { privateKey } = JSON.parse(readFileSync(join(dir, 'fed.json'), 'utf8')).identity as { privateKey: string };
    stale.signature = ed25519Sign(privateKey, `${stale.timestamp}.${stale.nonce}.${canonicalJson(stale.body)}`);
    expect(b.verifyEnvelope(stale, a.identity().publicKey)).toBe(false);
  });

  it('ReplayGuard enforces window + single use', () => {
    const g = new ReplayGuard(1_000);
    const now = 10_000;
    expect(g.checkAndRecord('peer', now, 'nonce-12345678', now)).toBe(true);
    expect(g.checkAndRecord('peer', now, 'nonce-12345678', now)).toBe(false);
    expect(g.checkAndRecord('peer', now - 5_000, 'nonce-87654321', now)).toBe(false);
    expect(g.checkAndRecord('other', now, 'nonce-12345678', now)).toBe(true);
  });
});

describe('invite + handshake', () => {
  it('completes a link: both sides hold an active peer record', () => {
    const a = service('A');
    const b = service('B', 'b.json');
    const { payload } = a.createInvite({ policyForPeer: { exposedBotIds: ['helper'] } });
    const parsed = b.parseInvitePayload(payload);
    expect(parsed.instanceId).toBe(a.identity().instanceId);
    const bPeer = b.recordPeerFromInvite(parsed, { exposedBotIds: ['coder'] });
    expect(bPeer.status).toBe('pending');
    const aPeer = a.completeHandshake({ inviteCode: parsed.code, remote: b.identity() });
    expect(aPeer.status).toBe('active');
    expect(aPeer.policy.exposedBotIds).toEqual(['helper']);
    b.markPeerActive(a.identity().instanceId);
    expect(b.getPeer(a.identity().instanceId)?.status).toBe('active');
    expect(b.getPeer(a.identity().instanceId)?.policy.exposedBotIds).toEqual(['coder']);
  });

  it('invite codes are single-use and self-links are refused', () => {
    const a = service('A');
    const b = service('B', 'b.json');
    const { payload } = a.createInvite();
    const parsed = b.parseInvitePayload(payload);
    a.completeHandshake({ inviteCode: parsed.code, remote: b.identity() });
    expect(() => a.completeHandshake({ inviteCode: parsed.code, remote: b.identity() })).toThrow(FederationError);
    expect(() => a.parseInvitePayload(payload.replace(parsed.instanceId, a.identity().instanceId))).toThrow();
    expect(() => b.parseInvitePayload('not-an-invite')).toThrow(FederationError);
  });

  it('rejects a handshake whose instance id does not match its key', () => {
    const a = service('A');
    const b = service('B', 'b.json');
    const { payload } = a.createInvite();
    const parsed = b.parseInvitePayload(payload);
    expect(() =>
      a.completeHandshake({ inviteCode: parsed.code, remote: { ...b.identity(), instanceId: 'kd_forged000000000' } }),
    ).toThrow(/does not match/);
  });
});

describe('signed HTTP requests', () => {
  it('verifies a signed request and rejects replay + forgery', () => {
    const a = service('A');
    const b = service('B', 'b.json');
    const headers = a.signRequestHeaders('POST', '/api/federation/inbound/chat', '{"x":1}');
    const ok = b.verifyRequest({
      method: 'POST',
      path: '/api/federation/inbound/chat',
      rawBody: '{"x":1}',
      headers,
      publicKey: a.identity().publicKey,
      expectedFrom: a.identity().instanceId,
    });
    expect(ok.from).toBe(a.identity().instanceId);
    // Replay of the exact same headers must fail.
    expect(() =>
      b.verifyRequest({ method: 'POST', path: '/api/federation/inbound/chat', rawBody: '{"x":1}', headers, publicKey: a.identity().publicKey }),
    ).toThrow(FederationError);
    // Forged signature must fail.
    const forged = { ...a.signRequestHeaders('POST', '/api/federation/inbound/chat', '{"x":1}'), 'x-kriyadot-fed-sig': 'AAAA' };
    expect(() =>
      b.verifyRequest({ method: 'POST', path: '/api/federation/inbound/chat', rawBody: '{"x":1}', headers: forged, publicKey: a.identity().publicKey }),
    ).toThrow(/signature/);
  });
});

describe('policy, rate caps and stubs', () => {
  it('default policy is chat-only with no exposed bots', () => {
    expect(defaultTunnelPolicy()).toEqual({ exposedBotIds: [], capabilities: ['chat'], rateCapPerMinute: 30 });
  });

  it('rate cap trips after the configured number of hits', () => {
    const a = service('A');
    const b = service('B', 'b.json');
    const { payload } = a.createInvite({ policyForPeer: { exposedBotIds: [], rateCapPerMinute: 2 } });
    const parsed = b.parseInvitePayload(payload);
    a.completeHandshake({ inviteCode: parsed.code, remote: b.identity() });
    const peerId = b.identity().instanceId;
    expect(a.checkRate(peerId)).toBe(true);
    expect(a.checkRate(peerId)).toBe(true);
    expect(a.checkRate(peerId)).toBe(false);
  });

  it('stubs upsert by remote session and unlink removes peers + stubs', () => {
    const a = service('A');
    const s1 = a.upsertStub('peer-1', 'bot-1', 'sess-1');
    const s2 = a.upsertStub('peer-1', 'bot-1', 'sess-1');
    expect(s2.createdAt).toBe(s1.createdAt);
    expect(s2.turnCount).toBe(2);
    expect(a.findStub('peer-1', 'bot-1')?.remoteSessionId).toBe('sess-1');
    a.recordPeerFromInvite({
      kind: 'kriyadot-federation-invite',
      v: 1,
      inviteId: 'inv_x',
      code: 'c',
      instanceId: 'peer-1',
      name: 'P',
      url: 'http://127.0.0.1:9/api/federation',
      publicKey: 'pk',
      expiresAt: Date.now() + 60_000,
    });
    expect(a.removePeer('peer-1')).toBe(true);
    expect(a.getPeer('peer-1')).toBeUndefined();
    expect(a.listStubs()).toEqual([]);
    expect(a.removePeer('peer-1')).toBe(false);
  });
});
