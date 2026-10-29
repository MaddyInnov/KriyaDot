// SPDX-License-Identifier: Apache-2.0
//
// Federation / bridge (Octop parity §2.8 — instance-to-instance linking).
//
// Links TWO KriyaDot instances — and only KriyaDot instances — so a user on
// instance A can chat with bots ("experts") exposed by instance B, with the
// turn always EXECUTING on the home instance (B). A keeps only a reference
// stub ({ peerId, botId, remoteSessionId, timestamps }); full transcripts
// live exclusively on the home instance ("home-authoritative history").
//
// Trust model:
//   - Each instance owns one Ed25519 keypair, generated once and persisted
//     (mode 0600) in the federation store file injected by the host.
//   - Linking starts out-of-band: A creates an invite payload carrying A's
//     public key + federation URL + a single-use code. B accepts the invite
//     (a local, audit-logged trust action) and answers with a signed
//     handshake that presents B's public key and the invite code. The code
//     is the trust anchor for that first exchange; every later request is
//     authenticated purely by Ed25519 signatures from the stored peer keys.
//   - Every federated HTTP request is signed over
//     METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256(rawBody)
//     with a 5-minute timestamp window and single-use nonces (replay guard),
//     so a captured request cannot be replayed or retargeted.
//   - Each peer record carries the RECEIVING side's tunnel policy: which
//     local bots are exposed to that peer, which capabilities are allowed
//     ('chat' | 'workspace-read', default chat only) and a per-minute rate
//     cap. The policy is enforced on the home instance for every inbound
//     request — a peer can never reach an unexposed bot.
//
// This module is framework-free (no Express): the API layer wires it to
// HTTP in apps/api/src/federation-routes.ts. Original implementation;
// Octop's bridge served as behavioural reference only.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FederationCapability = 'chat' | 'workspace-read';

export interface TunnelPolicy {
  /** Local bot ids exposed to this peer as "experts". Empty = none. */
  exposedBotIds: string[];
  /** Allowed capabilities. Default: chat only. */
  capabilities: FederationCapability[];
  /** Max inbound requests per minute from this peer. */
  rateCapPerMinute: number;
}

export function defaultTunnelPolicy(partial?: Partial<TunnelPolicy>): TunnelPolicy {
  return {
    exposedBotIds: [...(partial?.exposedBotIds ?? [])],
    capabilities: [...(partial?.capabilities ?? ['chat'])],
    rateCapPerMinute: partial?.rateCapPerMinute ?? 30,
  };
}

export interface PublicIdentity {
  instanceId: string;
  name: string;
  /** Base64 DER (SPKI) Ed25519 public key. */
  publicKey: string;
  /** Federation base URL peers should call, e.g. https://host/api/federation. */
  url: string;
}

export interface PeerRecord {
  /** The remote instance's id. */
  peerId: string;
  name: string;
  /** The remote instance's federation base URL. */
  url: string;
  /** Base64 DER (SPKI) Ed25519 public key of the remote instance. */
  publicKey: string;
  status: 'active' | 'pending';
  /** MY tunnel policy toward this peer (enforced on my inbound routes). */
  policy: TunnelPolicy;
  createdAt: number;
  linkedAt: number | null;
}

export interface InvitePayload {
  kind: 'kriyadot-federation-invite';
  v: 1;
  inviteId: string;
  /** Single-use handshake code — the trust anchor for the first exchange. */
  code: string;
  instanceId: string;
  name: string;
  url: string;
  publicKey: string;
  expiresAt: number;
}

export interface InviteRecord {
  inviteId: string;
  code: string;
  expiresAt: number;
  createdAt: number;
  usedAt: number | null;
  /** Policy the inviter will grant the acceptor once the handshake lands. */
  policyForPeer: TunnelPolicy;
}

/** Home-authoritative history: the local side stores ONLY this stub. */
export interface RemoteSessionStub {
  peerId: string;
  botId: string;
  remoteSessionId: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
}

export class FederationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = 'FederationError';
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively, arrays preserved. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Ed25519 helpers
// ---------------------------------------------------------------------------

function generateIdentityKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

export function instanceIdForPublicKey(publicKeyB64: string): string {
  return `kd_${sha256Hex(Buffer.from(publicKeyB64, 'base64')).slice(0, 16)}`;
}

export function ed25519Sign(privateKeyB64: string, data: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return cryptoSign(null, Buffer.from(data, 'utf8'), key).toString('base64');
}

export function ed25519Verify(publicKeyB64: string, data: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(data, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Signed envelopes (payload-level; used for invites/handshake-style payloads
// and directly unit-tested) + replay guard
// ---------------------------------------------------------------------------

export interface SignedEnvelope {
  v: 1;
  /** Sender instance id. */
  from: string;
  timestamp: number;
  nonce: string;
  body: unknown;
  /** Ed25519 signature over `${timestamp}.${nonce}.${canonicalJson(body)}`. */
  signature: string;
}

export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** Single-use nonce registry with a sliding timestamp window. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs: number = DEFAULT_REPLAY_WINDOW_MS) {}

  /**
   * Validate a timestamp + nonce pair. Returns true (and records the nonce)
   * only when the timestamp is inside the window and the nonce is fresh for
   * the given scope (usually the sender id). Replays and stale stamps fail.
   */
  checkAndRecord(scope: string, timestamp: number, nonce: string, now: number = Date.now()): boolean {
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > this.windowMs) return false;
    if (typeof nonce !== 'string' || nonce.length < 8) return false;
    this.prune(now);
    const key = `${scope}:${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }

  prune(now: number = Date.now()): void {
    for (const [k, at] of this.seen) {
      if (now - at > this.windowMs * 2) this.seen.delete(k);
    }
  }
}

export function envelopeSigningString(timestamp: number, nonce: string, body: unknown): string {
  return `${timestamp}.${nonce}.${canonicalJson(body)}`;
}

// ---------------------------------------------------------------------------
// HTTP request signing (header-based; the routes' wire format)
// ---------------------------------------------------------------------------

export const FED_HEADERS = {
  from: 'x-kriyadot-fed-from',
  timestamp: 'x-kriyadot-fed-ts',
  nonce: 'x-kriyadot-fed-nonce',
  signature: 'x-kriyadot-fed-sig',
} as const;

export function requestSigningString(method: string, path: string, timestamp: number, nonce: string, rawBody: string): string {
  return [method.toUpperCase(), path, String(timestamp), nonce, sha256Hex(rawBody)].join('\n');
}

export interface SignedRequestHeaders {
  [FED_HEADERS.from]: string;
  [FED_HEADERS.timestamp]: string;
  [FED_HEADERS.nonce]: string;
  [FED_HEADERS.signature]: string;
}

// ---------------------------------------------------------------------------
// Persistent store
// ---------------------------------------------------------------------------

interface StoredIdentity extends PublicIdentity {
  /** Base64 DER (PKCS8) — secret; the store file is written mode 0600. */
  privateKey: string;
  createdAt: number;
}

interface FederationStoreFile {
  version: 1;
  identity: StoredIdentity;
  invites: InviteRecord[];
  peers: PeerRecord[];
  stubs: RemoteSessionStub[];
}

function atomicWrite0600(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  renameSync(tmp, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// FederationService
// ---------------------------------------------------------------------------

export interface FederationServiceOptions {
  /** Path of the JSON store file (identity, invites, peers, stubs). */
  storePath: string;
  /** Display name for this instance (used until changed). */
  name?: string;
  /** This instance's federation base URL as peers should call it. */
  publicUrl?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  replayWindowMs?: number;
}

export class FederationService {
  private readonly storePath: string;
  private readonly nowFn: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly replay: ReplayGuard;
  private store: FederationStoreFile;
  /** In-memory sliding-window rate counters: peerId -> request timestamps. */
  private readonly rateHits = new Map<string, number[]>();

  constructor(opts: FederationServiceOptions) {
    this.storePath = opts.storePath;
    this.nowFn = opts.now ?? (() => Date.now());
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.replay = new ReplayGuard(opts.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS);
    this.store = this.loadOrCreate(opts);
  }

  private loadOrCreate(opts: FederationServiceOptions): FederationStoreFile {
    if (existsSync(this.storePath)) {
      const parsed = JSON.parse(readFileSync(this.storePath, 'utf8')) as FederationStoreFile;
      if (parsed.version !== 1 || !parsed.identity?.privateKey) {
        throw new FederationError(`Federation store at ${this.storePath} is corrupt or foreign — refusing to use it.`, 'store_corrupt', 500);
      }
      // Host-supplied name/url refresh the advertised identity.
      if (opts.name) parsed.identity.name = opts.name;
      if (opts.publicUrl) parsed.identity.url = opts.publicUrl;
      return parsed;
    }
    const keys = generateIdentityKeys();
    const store: FederationStoreFile = {
      version: 1,
      identity: {
        instanceId: instanceIdForPublicKey(keys.publicKey),
        name: opts.name ?? 'KriyaDot instance',
        url: opts.publicUrl ?? '',
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        createdAt: this.nowFn(),
      },
      invites: [],
      peers: [],
      stubs: [],
    };
    this.store = store;
    this.persist();
    return store;
  }

  private persist(): void {
    atomicWrite0600(this.storePath, `${JSON.stringify(this.store, null, 2)}\n`);
  }

  // ---- identity -----------------------------------------------------------

  identity(): PublicIdentity {
    const { instanceId, name, publicKey, url } = this.store.identity;
    return { instanceId, name, publicKey, url };
  }

  setPublicUrl(url: string): void {
    this.store.identity.url = url;
    this.persist();
  }

  // ---- envelopes ----------------------------------------------------------

  signEnvelope(body: unknown): SignedEnvelope {
    const timestamp = this.nowFn();
    const nonce = randomBytes(16).toString('base64url');
    return {
      v: 1,
      from: this.store.identity.instanceId,
      timestamp,
      nonce,
      body,
      signature: ed25519Sign(this.store.identity.privateKey, envelopeSigningString(timestamp, nonce, body)),
    };
  }

  /** Verify an envelope against a KNOWN public key (never a presented one). */
  verifyEnvelope(envelope: SignedEnvelope, publicKeyB64: string): boolean {
    if (!envelope || envelope.v !== 1 || typeof envelope.signature !== 'string') return false;
    if (!ed25519Verify(publicKeyB64, envelopeSigningString(envelope.timestamp, envelope.nonce, envelope.body), envelope.signature)) {
      return false;
    }
    return this.replay.checkAndRecord(envelope.from, envelope.timestamp, envelope.nonce, this.nowFn());
  }

  // ---- HTTP request signing -------------------------------------------------

  signRequestHeaders(method: string, path: string, rawBody: string): SignedRequestHeaders {
    const timestamp = this.nowFn();
    const nonce = randomBytes(16).toString('base64url');
    const signature = ed25519Sign(
      this.store.identity.privateKey,
      requestSigningString(method, path, timestamp, nonce, rawBody),
    );
    return {
      [FED_HEADERS.from]: this.store.identity.instanceId,
      [FED_HEADERS.timestamp]: String(timestamp),
      [FED_HEADERS.nonce]: nonce,
      [FED_HEADERS.signature]: signature,
    };
  }

  /**
   * Verify an inbound signed request against a known public key. Throws
   * FederationError (401) on any failure: bad signature, stale timestamp,
   * replayed nonce, or a `from` that does not match `expectedFrom`.
   */
  verifyRequest(args: {
    method: string;
    path: string;
    rawBody: string;
    headers: Record<string, string | undefined>;
    publicKey: string;
    expectedFrom?: string;
  }): { from: string } {
    const from = args.headers[FED_HEADERS.from];
    const tsRaw = args.headers[FED_HEADERS.timestamp];
    const nonce = args.headers[FED_HEADERS.nonce];
    const signature = args.headers[FED_HEADERS.signature];
    if (!from || !tsRaw || !nonce || !signature) {
      throw new FederationError('missing federation signature headers', 'bad_signature', 401);
    }
    if (args.expectedFrom && from !== args.expectedFrom) {
      throw new FederationError('federation sender mismatch', 'bad_signature', 401);
    }
    const timestamp = Number(tsRaw);
    const okSig =
      Number.isFinite(timestamp) &&
      ed25519Verify(args.publicKey, requestSigningString(args.method, args.path, timestamp, nonce, args.rawBody), signature);
    if (!okSig) throw new FederationError('invalid federation signature', 'bad_signature', 401);
    if (!this.replay.checkAndRecord(from, timestamp, nonce, this.nowFn())) {
      throw new FederationError('federation request replayed or outside the timestamp window', 'replay', 401);
    }
    return { from };
  }

  // ---- invites + handshake --------------------------------------------------

  createInvite(opts?: { policyForPeer?: Partial<TunnelPolicy>; expiresInMs?: number }): { payload: string; invite: InviteRecord } {
    const now = this.nowFn();
    const record: InviteRecord = {
      inviteId: `inv_${randomUUID()}`,
      code: randomBytes(18).toString('base64url'),
      expiresAt: now + (opts?.expiresInMs ?? 24 * 60 * 60 * 1000),
      createdAt: now,
      usedAt: null,
      policyForPeer: defaultTunnelPolicy(opts?.policyForPeer),
    };
    this.store.invites.push(record);
    this.persist();
    const payloadObj: InvitePayload = {
      kind: 'kriyadot-federation-invite',
      v: 1,
      inviteId: record.inviteId,
      code: record.code,
      instanceId: this.store.identity.instanceId,
      name: this.store.identity.name,
      url: this.store.identity.url,
      publicKey: this.store.identity.publicKey,
      expiresAt: record.expiresAt,
    };
    return { payload: Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url'), invite: record };
  }

  parseInvitePayload(payload: string): InvitePayload {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload.trim(), 'base64url').toString('utf8'));
    } catch {
      throw new FederationError('invite payload is not valid base64url JSON', 'bad_invite', 400);
    }
    const p = parsed as Partial<InvitePayload>;
    if (
      p.kind !== 'kriyadot-federation-invite' ||
      p.v !== 1 ||
      typeof p.instanceId !== 'string' ||
      typeof p.publicKey !== 'string' ||
      typeof p.url !== 'string' ||
      typeof p.code !== 'string' ||
      typeof p.expiresAt !== 'number'
    ) {
      throw new FederationError('invite payload is not a KriyaDot federation invite', 'bad_invite', 400);
    }
    if (p.instanceId === this.store.identity.instanceId) {
      throw new FederationError('cannot link an instance to itself', 'bad_invite', 400);
    }
    if (p.expiresAt < this.nowFn()) throw new FederationError('invite has expired', 'invite_expired', 400);
    return p as InvitePayload;
  }

  /** Acceptor side: store the inviter as a peer from its invite payload. */
  recordPeerFromInvite(payload: InvitePayload, myPolicy?: Partial<TunnelPolicy>): PeerRecord {
    const existing = this.store.peers.find((p) => p.peerId === payload.instanceId);
    const record: PeerRecord = {
      peerId: payload.instanceId,
      name: payload.name ?? payload.instanceId,
      url: payload.url.replace(/\/+$/, ''),
      publicKey: payload.publicKey,
      status: 'pending',
      policy: defaultTunnelPolicy(myPolicy),
      createdAt: existing?.createdAt ?? this.nowFn(),
      linkedAt: existing?.linkedAt ?? null,
    };
    this.store.peers = [...this.store.peers.filter((p) => p.peerId !== payload.instanceId), record];
    this.persist();
    return record;
  }

  markPeerActive(peerId: string): PeerRecord {
    const peer = this.getPeer(peerId);
    if (!peer) throw new FederationError(`unknown peer ${peerId}`, 'unknown_peer', 404);
    peer.status = 'active';
    peer.linkedAt = this.nowFn();
    this.persist();
    return peer;
  }

  /**
   * Inviter side: complete a handshake. The caller (routes) has ALREADY
   * verified the request signature against the presented public key; the
   * single-use invite code checked here is what binds that presented key to
   * this invite. Consumes the code.
   */
  completeHandshake(args: {
    inviteCode: string;
    remote: { instanceId: string; name: string; url: string; publicKey: string };
  }): PeerRecord {
    const now = this.nowFn();
    const invite = this.store.invites.find((i) => i.code === args.inviteCode);
    if (!invite) throw new FederationError('unknown invite code', 'bad_invite', 401);
    if (invite.usedAt !== null) throw new FederationError('invite code already used', 'invite_used', 401);
    if (invite.expiresAt < now) throw new FederationError('invite has expired', 'invite_expired', 401);
    if (instanceIdForPublicKey(args.remote.publicKey) !== args.remote.instanceId) {
      throw new FederationError('presented instance id does not match its public key', 'bad_signature', 401);
    }
    invite.usedAt = now;
    const record: PeerRecord = {
      peerId: args.remote.instanceId,
      name: args.remote.name || args.remote.instanceId,
      url: args.remote.url.replace(/\/+$/, ''),
      publicKey: args.remote.publicKey,
      status: 'active',
      policy: invite.policyForPeer,
      createdAt: now,
      linkedAt: now,
    };
    this.store.peers = [...this.store.peers.filter((p) => p.peerId !== record.peerId), record];
    this.persist();
    return record;
  }

  // ---- peers ----------------------------------------------------------------

  getPeer(peerId: string): PeerRecord | undefined {
    return this.store.peers.find((p) => p.peerId === peerId);
  }

  listPeers(): PeerRecord[] {
    return [...this.store.peers];
  }

  removePeer(peerId: string): boolean {
    const before = this.store.peers.length;
    this.store.peers = this.store.peers.filter((p) => p.peerId !== peerId);
    this.store.stubs = this.store.stubs.filter((s) => s.peerId !== peerId);
    if (this.store.peers.length !== before) this.persist();
    return this.store.peers.length !== before;
  }

  updatePeerPolicy(peerId: string, partial: Partial<TunnelPolicy>): PeerRecord {
    const peer = this.getPeer(peerId);
    if (!peer) throw new FederationError(`unknown peer ${peerId}`, 'unknown_peer', 404);
    peer.policy = defaultTunnelPolicy({ ...peer.policy, ...partial });
    this.persist();
    return peer;
  }

  /** Sliding-window rate check against the peer's tunnel policy cap. */
  checkRate(peerId: string): boolean {
    const peer = this.getPeer(peerId);
    if (!peer) return false;
    const now = this.nowFn();
    const hits = (this.rateHits.get(peerId) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= peer.policy.rateCapPerMinute) {
      this.rateHits.set(peerId, hits);
      return false;
    }
    hits.push(now);
    this.rateHits.set(peerId, hits);
    return true;
  }

  // ---- remote session stubs (home-authoritative history) ---------------------

  upsertStub(peerId: string, botId: string, remoteSessionId: string): RemoteSessionStub {
    const now = this.nowFn();
    const existing = this.store.stubs.find((s) => s.peerId === peerId && s.botId === botId && s.remoteSessionId === remoteSessionId);
    if (existing) {
      existing.updatedAt = now;
      existing.turnCount += 1;
      this.persist();
      return existing;
    }
    const stub: RemoteSessionStub = { peerId, botId, remoteSessionId, createdAt: now, updatedAt: now, turnCount: 1 };
    this.store.stubs.push(stub);
    this.persist();
    return stub;
  }

  findStub(peerId: string, botId: string): RemoteSessionStub | undefined {
    // Most recently updated stub for (peer, bot) — the live conversation.
    return [...this.store.stubs]
      .filter((s) => s.peerId === peerId && s.botId === botId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  listStubs(): RemoteSessionStub[] {
    return [...this.store.stubs];
  }

  // ---- signed client ----------------------------------------------------------

  /**
   * Signed request to a linked peer's federation base URL. `path` is the
   * path UNDER the federation base (e.g. '/inbound/chat'). Throws
   * FederationError carrying the peer's HTTP status on non-2xx.
   */
  async signedPeerRequest<T>(peer: PeerRecord, method: string, path: string, body?: unknown): Promise<T> {
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const url = `${peer.url.replace(/\/+$/, '')}${path}`;
    const pathname = new URL(url).pathname;
    const headers = this.signRequestHeaders(method, pathname, rawBody);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { ...headers, ...(rawBody ? { 'Content-Type': 'application/json' } : {}) },
        ...(rawBody ? { body: rawBody } : {}),
      });
    } catch (err) {
      throw new FederationError(
        `cannot reach peer at ${peer.url}: ${err instanceof Error ? err.message : String(err)}`,
        'peer_unreachable',
        502,
      );
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON peer response */
    }
    if (!res.ok) {
      const body = json as { error?: string; code?: string } | null;
      const message = body?.error ?? `peer responded ${res.status}`;
      // Preserve the peer's machine-readable error code (e.g. bot_not_exposed).
      throw new FederationError(message, body?.code ?? 'peer_error', res.status);
    }
    return json as T;
  }
}
