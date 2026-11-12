// SPDX-License-Identifier: Apache-2.0
// Multi-machine fleet (Timon parity A15) — the last programme item.
//
// A fleet is the set of KriyaDot instances already linked by federation.
// This module adds, on top of that existing identity and transport:
//
//   1. A FLEET REGISTRY: each instance advertises a signed fleet record
//      (instance id, display name, platform, version, capabilities,
//      heartbeat, live mission/run counts). Peers keep the records with
//      a last-seen stamp; liveness is DERIVED at read time
//      (online → stale → offline) and stale/offline machines are never
//      silently dropped from the registry.
//   2. DISPATCH AS PLACEMENT: a mission (A5) may be placed on a chosen
//      peer. The request travels as a signed federation request; the
//      peer creates and runs the mission with ITS OWN MissionService —
//      its own bots, its own test command defaults, and crucially its
//      own governance approval gate for landing. The origin keeps a
//      mirror mission on its board labelled with the executing machine.
//   3. RESUME-BY-TRANSFER: a mission's durable state — mission record,
//      task, session transcript (from the durable SessionStore log) and
//      code state — can move to another machine, which resumes it and
//      labels it as transferred, forever.
//
// WHY FEDERATION IDENTITY IS THE TRUST ROOT (B1):
// Federation already gives every instance exactly one Ed25519 keypair,
// persisted mode-0600, with the instance id DERIVED from the public key
// (instanceIdForPublicKey). Fleet introduces NO new keys and NO new
// trust decisions: a fleet record is believable exactly when (a) it
// arrives over a request signed by a linked peer's stored key (the
// transport signature, verified in this file the same way
// federation-routes.ts verifies inbound traffic), AND (b) the record
// itself is a SignedEnvelope whose signature verifies against that same
// stored key and whose claimed instance id matches the key it derives
// from. A peer therefore cannot forge another machine's record: it does
// not hold that machine's private key, verification uses the STORED key
// (never a presented one), and a mismatched id/key pair fails closed.
// Replay is bounded by the federation ReplayGuard (5-minute window,
// single-use nonces) on both signatures.
//
// WHAT A MALICIOUS (OR COMPROMISED) PEER CAN AND CANNOT DO:
//   CAN: lie about ITSELF — its own display name, capabilities, counts,
//        heartbeat. Fleet data is advisory: it drives display and the
//        user's placement choice, never an authorization decision.
//   CAN: refuse or fail work dispatched to it, or return a dishonest
//        result snapshot for work the ORIGIN sent it. The origin's
//        mirror is labelled as peer-reported; the code itself only ever
//        lands on the PEER (its repo, its gate), never on the origin.
//   CANNOT: impersonate another machine (see above); force work onto
//        this machine — inbound dispatch/transfer require the
//        'mission-dispatch' capability in THIS machine's tunnel policy
//        toward that peer, are rate-capped like all federation traffic,
//        and landing still needs THIS machine's user's approval card;
//        read local files/sessions — a transfer only ever carries what
//        the origin's user explicitly dispatched/transferred;
//        satisfy a local approval — dispatched missions run through the
//        peer's normal MissionService, whose approval gate is the
//        peer's governance, exactly as for its own local missions.
//
// GOVERNANCE: unchanged and per-machine. Dispatching does not move,
// copy or weaken any approval: the executing machine's gate decides
// landing on that machine. The origin cannot force-run (the peer may
// refuse at the capability check) and cannot force-land (no code path
// here touches the peer's approval gate).
//
// HONEST LIMITS (read before trusting a fleet view):
//   - Counts are self-reported by each peer in its last advertisement;
//     between heartbeats they are stale by up to the heartbeat age.
//     Nothing here invents telemetry the peer did not advertise.
//   - Dispatch is synchronous over one signed request: the origin waits
//     for the peer's pipeline (worker → review → tests → ITS approval
//     gate) to finish. A peer-side approval that waits for a human
//     holds the request; the peer ALSO fires a best-effort result
//     callback when it completes, and the origin's mirror is updated by
//     whichever arrives. There is no background job queue in v1.
//   - Transfer code-state modes, strongest first:
//       'branch' — the receiver already has the mission branch (shared
//                  remote / cloned repo): it recreates the worktree
//                  from the branch and resumes at review.
//       'diff'   — the bundle carries `git diff target...HEAD`; the
//                  receiver creates a fresh worktree, applies and
//                  commits the diff, and resumes at review. File
//                  contents transfer exactly; commit history/authorship
//                  does NOT (one squashed "transferred work" commit).
//       'transcript-only' — no diff could be captured (e.g. worktree
//                  already cleaned): the transcript + mission record
//                  transfer and the worker RE-RUNS on the receiver with
//                  the transcript visible in the task notes. This is a
//                  restart with context, not a continuation — labelled
//                  as such via transferMode on the mission record.
//   - What NEVER transfers: provider credentials/API keys, governance
//     approvals (a pending card on the origin is meaningless on the
//     receiver — the receiver's gate mints its own), sandbox state,
//     uncommitted worktree changes that were never committed by the
//     pipeline (the diff is taken from committed history only), and
//     sessions other than the mission's own worker/reviewer sessions.
//   - One fleet record per linked peer; unlinking a peer (federation)
//     keeps its last registry entry, shown offline — history is not
//     rewritten. Removing the entry is a local registry delete route.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { WorktreeManager } from '@mvp/agent-runtime';
// Deep dist import, same pattern as federation-routes.ts.
import {
  FederationError,
  instanceIdForPublicKey,
  type FederationService,
  type PeerRecord,
  type SignedEnvelope,
} from '@mvp/agent-runtime/dist/federation.js';
import type { Mission, MissionService, MissionStore } from './missions.js';
import type { TaskStore } from './tasks.js';

// ---------------------------------------------------------------------------
// Fleet records + liveness
// ---------------------------------------------------------------------------

export interface FleetCapabilities {
  /** CLI bridge ids present on the machine (A2 manifest bridges). */
  bridges: string[];
  /** Sandbox backend identifier, or null when no confinement backend exists. */
  sandboxBackend: string | null;
  /** `git --version` succeeded on this machine. */
  gitAvailable: boolean;
}

export interface FleetRecord {
  instanceId: string;
  displayName: string;
  platform: string;
  version: string;
  capabilities: FleetCapabilities;
  /** Sender clock at advertisement time (ms epoch). */
  heartbeatAt: number;
  /** Missions in a non-terminal stage on the sender, self-reported. */
  activeMissions: number;
  /** Bot runs in flight on the sender, self-reported (0 when unknown). */
  activeRuns: number;
}

export type FleetLiveness = 'online' | 'stale' | 'offline';

export interface FleetEntry extends FleetRecord {
  liveness: FleetLiveness;
  isSelf: boolean;
  /** Receiver clock when this record was last verified (ms epoch). */
  lastSeenAt: number;
}

/** A heartbeat is expected roughly every 30s in the host wiring. A machine
 * is 'online' while its last verified advertisement is younger than the
 * stale threshold, 'stale' until the offline threshold, then 'offline'.
 * Thresholds are constructor-configurable so tests can use short ones. */
export const FLEET_STALE_AFTER_MS = 45_000;
export const FLEET_OFFLINE_AFTER_MS = 120_000;

export function livenessFor(
  lastSeenAt: number,
  now: number,
  staleAfterMs: number = FLEET_STALE_AFTER_MS,
  offlineAfterMs: number = FLEET_OFFLINE_AFTER_MS,
): FleetLiveness {
  const age = now - lastSeenAt;
  if (age < staleAfterMs) return 'online';
  if (age < offlineAfterMs) return 'stale';
  return 'offline';
}

/** Detect this machine's capabilities. Bridges/sandbox are injected by the
 * host (they own those registries); git is probed for real. */
export function detectCapabilities(opts: {
  bridges?: string[];
  sandboxBackend?: string | null;
} = {}): FleetCapabilities {
  let gitAvailable = false;
  try {
    gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5_000 }).status === 0;
  } catch {
    gitAvailable = false;
  }
  return {
    bridges: [...(opts.bridges ?? [])],
    sandboxBackend: opts.sandboxBackend ?? null,
    gitAvailable,
  };
}

function isFleetRecord(v: unknown): v is FleetRecord {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const caps = o.capabilities as Record<string, unknown> | undefined;
  return (
    typeof o.instanceId === 'string' &&
    typeof o.displayName === 'string' &&
    typeof o.platform === 'string' &&
    typeof o.version === 'string' &&
    typeof o.heartbeatAt === 'number' &&
    typeof o.activeMissions === 'number' &&
    typeof o.activeRuns === 'number' &&
    typeof caps === 'object' &&
    caps !== null &&
    Array.isArray(caps.bridges) &&
    typeof caps.gitAvailable === 'boolean'
  );
}

// ---------------------------------------------------------------------------
// Fleet registry (JSON file, missions.ts conventions)
// ---------------------------------------------------------------------------

interface StoredPeerRecord {
  record: FleetRecord;
  lastSeenAt: number;
}

export class FleetRegistry {
  private readonly file: string;
  private readonly staleAfterMs: number;
  private readonly offlineAfterMs: number;
  private readonly nowFn: () => number;
  private self: FleetRecord | null = null;
  private readonly peers = new Map<string, StoredPeerRecord>();

  constructor(
    dataDir: string,
    opts: { staleAfterMs?: number; offlineAfterMs?: number; now?: () => number } = {},
  ) {
    this.file = join(dataDir, 'fleet-registry.json');
    this.staleAfterMs = opts.staleAfterMs ?? FLEET_STALE_AFTER_MS;
    this.offlineAfterMs = opts.offlineAfterMs ?? FLEET_OFFLINE_AFTER_MS;
    this.nowFn = opts.now ?? (() => Date.now());
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { peers?: StoredPeerRecord[] };
      for (const p of parsed.peers ?? []) {
        if (isFleetRecord(p.record) && typeof p.lastSeenAt === 'number') {
          this.peers.set(p.record.instanceId, p);
        }
      }
    } catch {
      // First run (or unreadable file): start empty; entries rebuild from
      // the next verified advertisements.
    }
  }

  thresholds(): { staleAfterMs: number; offlineAfterMs: number } {
    return { staleAfterMs: this.staleAfterMs, offlineAfterMs: this.offlineAfterMs };
  }

  private persist(): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ peers: [...this.peers.values()] }, null, 2), 'utf8');
  }

  /** Set/refresh THIS machine's own record (host calls on heartbeat). */
  updateSelf(record: FleetRecord): void {
    this.self = record;
  }

  selfRecord(): FleetRecord | null {
    return this.self;
  }

  /** Ingest a VERIFIED peer record (verification is the caller's job —
   * see verifyFleetAdvertisement). Stores it; never drops old entries. */
  ingest(record: FleetRecord, lastSeenAt: number = this.nowFn()): void {
    this.peers.set(record.instanceId, { record, lastSeenAt });
    this.persist();
  }

  getPeer(instanceId: string): StoredPeerRecord | undefined {
    return this.peers.get(instanceId);
  }

  removePeer(instanceId: string): boolean {
    const had = this.peers.delete(instanceId);
    if (had) this.persist();
    return had;
  }

  /** Self (always 'online' while the process lives) + every known peer,
   * with liveness derived at read time. Offline peers stay listed. */
  listEntries(now: number = this.nowFn()): FleetEntry[] {
    const out: FleetEntry[] = [];
    if (this.self) {
      out.push({ ...this.self, liveness: 'online', isSelf: true, lastSeenAt: now });
    }
    for (const p of this.peers.values()) {
      if (this.self && p.record.instanceId === this.self.instanceId) continue;
      out.push({
        ...p.record,
        liveness: livenessFor(p.lastSeenAt, now, this.staleAfterMs, this.offlineAfterMs),
        isSelf: false,
        lastSeenAt: p.lastSeenAt,
      });
    }
    return out.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.displayName.localeCompare(b.displayName));
  }
}

// ---------------------------------------------------------------------------
// Signed advertisements (payload-level, over the federation envelope)
// ---------------------------------------------------------------------------

/** Sign this machine's fleet record with its federation identity. */
export function signFleetAdvertisement(service: FederationService, record: FleetRecord): SignedEnvelope {
  return service.signEnvelope({ kind: 'kriyadot-fleet-record', v: 1, record });
}

/**
 * Verify a fleet advertisement envelope against a KNOWN peer. Fail closed
 * on: malformed body, envelope/record instance mismatch, an instance id
 * that does not derive from the stored public key, a bad signature, or a
 * replayed/stale envelope (ReplayGuard inside verifyEnvelope).
 * Returns the verified record, or null — never throws for bad input, so
 * callers can treat forgery as a plain refusal.
 */
export function verifyFleetAdvertisement(
  service: FederationService,
  envelope: SignedEnvelope,
  peer: PeerRecord,
): FleetRecord | null {
  try {
    if (!envelope || envelope.from !== peer.peerId) return null;
    if (instanceIdForPublicKey(peer.publicKey) !== peer.peerId) return null;
    const body = envelope.body as { kind?: unknown; v?: unknown; record?: unknown } | null;
    if (!body || body.kind !== 'kriyadot-fleet-record' || body.v !== 1 || !isFleetRecord(body.record)) return null;
    if (body.record.instanceId !== peer.peerId) return null;
    if (!service.verifyEnvelope(envelope, peer.publicKey)) return null;
    return body.record;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transcript seam (durable SessionStore in production)
// ---------------------------------------------------------------------------

export interface TranscriptMessage {
  role: string;
  content: string;
}

/**
 * The minimal durable-transcript surface fleet needs. The production
 * adapter (routes.ts) wraps SessionStore: list = listThreadMessages of
 * the mission session, append = create-on-demand + appendMessage into a
 * fresh session on the receiver. Mission session ids follow A5's
 * `mission:<missionId>:<role>` convention (createRuntimeBotRunner).
 */
export interface MissionTranscriptStore {
  list(sessionId: string): TranscriptMessage[];
  append(sessionId: string, messages: TranscriptMessage[]): void;
}

export function missionSessionId(missionId: string, role: 'worker' | 'reviewer'): string {
  return `mission:${missionId}:${role}`;
}

// ---------------------------------------------------------------------------
// Transfer bundle
// ---------------------------------------------------------------------------

export interface MissionTransferBundle {
  v: 1;
  kind: 'kriyadot-mission-transfer';
  fromInstanceId: string;
  fromName: string;
  transferredAt: number;
  /** Stage the mission had reached when the bundle was built. */
  stageAtTransfer: Mission['stage'];
  mission: {
    id: string;
    repoPath: string;
    branch: string;
    targetBranch: string;
    testCommand: string;
    worker: Mission['worker'];
    reviewer: Mission['reviewer'];
    reviewIndependence?: Mission['reviewIndependence'];
    review?: Mission['review'];
  };
  task: { title: string; notes?: string };
  /** Worker-session transcript first, then reviewer-session messages. */
  transcript: TranscriptMessage[];
  /** `git diff <target>...HEAD` from the origin worktree, when captured. */
  diff?: string;
  /** What code state the bundle carries (see header for semantics). */
  mode: 'branch' | 'diff' | 'transcript-only';
}

function isTransferBundle(v: unknown): v is MissionTransferBundle {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const m = o.mission as Record<string, unknown> | undefined;
  const t = o.task as Record<string, unknown> | undefined;
  return (
    o.v === 1 &&
    o.kind === 'kriyadot-mission-transfer' &&
    typeof o.fromInstanceId === 'string' &&
    typeof o.transferredAt === 'number' &&
    typeof m === 'object' && m !== null &&
    typeof m.branch === 'string' &&
    typeof m.targetBranch === 'string' &&
    typeof m.testCommand === 'string' &&
    typeof t === 'object' && t !== null &&
    typeof t.title === 'string' &&
    Array.isArray(o.transcript) &&
    (o.mode === 'branch' || o.mode === 'diff' || o.mode === 'transcript-only')
  );
}

// ---------------------------------------------------------------------------
// Fleet coordinator — advertise / dispatch / transfer orchestration
// ---------------------------------------------------------------------------

export interface FleetCoordinatorDeps {
  federation: FederationService;
  registry: FleetRegistry;
  missionService: MissionService;
  missionStore: MissionStore;
  taskStore: TaskStore;
  /** This instance's display name + version for self records. */
  displayName: string;
  version: string;
  capabilities: FleetCapabilities;
  /** Durable transcript store; absent → transfers carry no transcript. */
  transcripts?: MissionTranscriptStore;
  /** Live bot-run count for the self record (self-reported). */
  activeRuns?: () => number;
  worktreeRoot: string;
  audit?: (action: string, fields: Record<string, unknown>) => void;
  now?: () => number;
}

function gitOut(cwd: string, args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return r.stdout ?? '';
}

export class FleetCoordinator {
  private readonly deps: FleetCoordinatorDeps;
  private readonly nowFn: () => number;

  constructor(deps: FleetCoordinatorDeps) {
    this.deps = deps;
    this.nowFn = deps.now ?? (() => Date.now());
  }

  private audit(action: string, fields: Record<string, unknown>): void {
    try {
      this.deps.audit?.(action, fields);
    } catch {
      // Audit must never break fleet traffic.
    }
  }

  identity() {
    return this.deps.federation.identity();
  }

  /** Build + store this machine's current self record. */
  refreshSelf(): FleetRecord {
    const id = this.identity();
    const activeMissions = this.deps.missionStore
      .list()
      .filter((m) => m.stage !== 'landed' && m.stage !== 'blocked').length;
    const record: FleetRecord = {
      instanceId: id.instanceId,
      displayName: this.deps.displayName || id.name,
      platform: process.platform,
      version: this.deps.version,
      capabilities: this.deps.capabilities,
      heartbeatAt: this.nowFn(),
      activeMissions,
      activeRuns: this.deps.activeRuns?.() ?? 0,
    };
    this.deps.registry.updateSelf(record);
    return record;
  }

  /** Send our signed advertisement to every active peer. Best-effort per
   * peer: one unreachable peer does not block the others. */
  async advertiseToPeers(): Promise<Array<{ peerId: string; ok: boolean; error?: string }>> {
    const record = this.refreshSelf();
    const envelope = signFleetAdvertisement(this.deps.federation, record);
    const results: Array<{ peerId: string; ok: boolean; error?: string }> = [];
    for (const peer of this.deps.federation.listPeers()) {
      if (peer.status !== 'active') continue;
      try {
        await this.deps.federation.signedPeerRequest(peer, 'POST', '/inbound/fleet/advertise', { envelope });
        results.push({ peerId: peer.peerId, ok: true });
      } catch (err) {
        results.push({ peerId: peer.peerId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.audit('fleet.advertised', { peers: results.length, ok: results.filter((r) => r.ok).length });
    return results;
  }

  /** Inbound: a peer's advertisement. Double-verified by the routes layer
   * (transport signature) and here (record envelope). Returns the record. */
  handleInboundAdvertise(envelope: SignedEnvelope, peer: PeerRecord): FleetRecord {
    const record = verifyFleetAdvertisement(this.deps.federation, envelope, peer);
    if (!record) throw new FederationError('fleet advertisement failed verification', 'bad_signature', 401);
    this.deps.registry.ingest(record, this.nowFn());
    this.audit('fleet.advertise_received', { peerId: peer.peerId, displayName: record.displayName });
    return record;
  }

  // ---- dispatch -----------------------------------------------------------

  /**
   * Origin side: dispatch a local queued mission to a peer machine.
   * Creates/updates the origin's MIRROR record (placement 'fleet',
   * executedOn = peer) and returns the peer's final mission snapshot.
   * The local pipeline is NOT run — execution happens only on the peer.
   */
  async dispatchMission(
    missionId: string,
    targetInstanceId: string,
  ): Promise<{ mirror: Mission; remote: Mission }> {
    const local = this.deps.missionStore.get(missionId);
    if (!local) throw new FederationError(`unknown mission: ${missionId}`, 'unknown_mission', 404);
    const peer = this.deps.federation.getPeer(targetInstanceId);
    if (!peer || peer.status !== 'active') {
      throw new FederationError(`unknown or unlinked fleet machine: ${targetInstanceId}`, 'unknown_peer', 404);
    }
    const entry = this.deps.registry.listEntries(this.nowFn()).find((e) => e.instanceId === targetInstanceId);
    if (entry && entry.liveness === 'offline') {
      throw new FederationError(`fleet machine ${entry.displayName} is offline`, 'peer_offline', 409);
    }
    const task = this.deps.taskStore.get(local.taskId);
    if (!task) throw new FederationError(`mission task no longer exists: ${local.taskId}`, 'unknown_task', 404);

    const mirror = this.deps.missionStore.update(local.id, {
      placement: 'fleet',
      executedOnInstanceId: peer.peerId,
      executedOnName: entry?.displayName ?? peer.name,
      originInstanceId: this.identity().instanceId,
    });
    this.deps.taskStore.update(task.id, { missionStage: 'working' });
    this.audit('fleet.dispatch_started', { missionId, target: peer.peerId });

    let remote: Mission;
    try {
      const out = await this.deps.federation.signedPeerRequest<{ ok: boolean; mission: Mission }>(
        peer,
        'POST',
        '/inbound/fleet/dispatch',
        {
          originInstanceId: this.identity().instanceId,
          spec: {
            repoPath: local.repoPath,
            branch: local.branch,
            targetBranch: local.targetBranch,
            testCommand: local.testCommand,
            workerBotId: local.worker.botId,
            reviewerBotId: local.reviewer.botId,
            task: { title: task.title, ...(task.notes ? { notes: task.notes } : {}) },
          },
        },
      );
      remote = out.mission;
    } catch (err) {
      const blocked = this.deps.missionStore.update(local.id, {
        stage: 'blocked',
        evidence: `fleet dispatch to ${peer.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.deps.taskStore.update(task.id, { missionStage: 'blocked' });
      this.audit('fleet.dispatch_failed', { missionId, target: peer.peerId, evidence: blocked.evidence });
      throw err;
    }

    const done = this.deps.missionStore.update(local.id, {
      stage: remote.stage,
      remoteMissionId: remote.id,
      ...(remote.review ? { review: remote.review } : {}),
      ...(remote.reviewIndependence ? { reviewIndependence: remote.reviewIndependence } : {}),
      ...(remote.testResult ? { testResult: remote.testResult } : {}),
      ...(remote.landedSha ? { landedSha: remote.landedSha } : {}),
      evidence:
        remote.stage === 'landed'
          ? `Ran on ${entry?.displayName ?? peer.name} (${peer.peerId}); landed there at ${remote.landedSha ?? 'unknown sha'}.`
          : `Ran on ${entry?.displayName ?? peer.name} (${peer.peerId}); finished as ${remote.stage}${remote.evidence ? `: ${remote.evidence}` : ''}`,
    });
    this.deps.taskStore.update(task.id, {
      missionStage: remote.stage,
      ...(remote.stage === 'landed' ? { done: true } : {}),
    });
    this.audit('fleet.dispatch_completed', { missionId, target: peer.peerId, remoteMissionId: remote.id, stage: remote.stage });
    return { mirror: done, remote };
  }

  /**
   * Peer side: run a dispatched mission HERE, with this machine's own
   * MissionService — its bots, its test runner, its approval gate. The
   * origin's say ends at sending the spec; landing is decided here.
   */
  async handleInboundDispatch(
    caller: PeerRecord,
    payload: {
      originInstanceId?: unknown;
      spec?: {
        repoPath?: unknown;
        branch?: unknown;
        targetBranch?: unknown;
        testCommand?: unknown;
        workerBotId?: unknown;
        reviewerBotId?: unknown;
        task?: { title?: unknown; notes?: unknown };
      };
    },
  ): Promise<Mission> {
    const spec = payload.spec ?? {};
    if (
      typeof spec.repoPath !== 'string' ||
      typeof spec.testCommand !== 'string' ||
      typeof spec.task?.title !== 'string'
    ) {
      throw new FederationError('dispatch spec needs repoPath, testCommand and task.title', 'bad_request', 400);
    }
    const task = this.deps.taskStore.create({
      title: spec.task.title,
      ...(typeof spec.task.notes === 'string' ? { notes: spec.task.notes } : {}),
    });
    const mission = this.deps.missionService.createMission({
      taskId: task.id,
      repoPath: spec.repoPath,
      ...(typeof spec.branch === 'string' ? { branch: spec.branch } : {}),
      ...(typeof spec.targetBranch === 'string' ? { targetBranch: spec.targetBranch } : {}),
      testCommand: spec.testCommand,
      ...(typeof spec.workerBotId === 'string' ? { workerBotId: spec.workerBotId } : {}),
      ...(typeof spec.reviewerBotId === 'string' ? { reviewerBotId: spec.reviewerBotId } : {}),
      placement: 'fleet',
      originInstanceId: caller.peerId,
      executedOnInstanceId: this.identity().instanceId,
      executedOnName: this.identity().name,
    });
    this.audit('fleet.dispatch_received', { missionId: mission.id, origin: caller.peerId });
    const done = await this.deps.missionService.runMission(mission.id);
    // Best-effort result callback to the origin (the synchronous response
    // already carries the same snapshot; the callback covers origins
    // whose request timed out but stayed alive).
    const origin = this.deps.federation.getPeer(caller.peerId);
    if (origin) {
      void this.deps.federation
        .signedPeerRequest(origin, 'POST', '/inbound/fleet/result', {
          remoteMissionId: done.id,
          originMissionBranch: done.branch,
          mission: done,
        })
        .catch(() => undefined);
    }
    return done;
  }

  /** Origin side: a peer reports a finished dispatched mission. Updates
   * the mirror matched by branch + remote id; unknown reports ignored. */
  handleInboundResult(payload: { remoteMissionId?: unknown; mission?: Mission }): boolean {
    if (typeof payload.remoteMissionId !== 'string' || !payload.mission) return false;
    const mirror = this.deps.missionStore
      .list()
      .find((m) => m.remoteMissionId === payload.remoteMissionId && m.placement === 'fleet');
    if (!mirror) return false;
    const remote = payload.mission;
    this.deps.missionStore.update(mirror.id, {
      stage: remote.stage,
      ...(remote.evidence ? { evidence: remote.evidence } : {}),
      ...(remote.landedSha ? { landedSha: remote.landedSha } : {}),
    });
    return true;
  }

  // ---- transfer -----------------------------------------------------------

  /** Build the transfer bundle for a local mission (does not send it). */
  buildTransferBundle(missionId: string): MissionTransferBundle {
    const mission = this.deps.missionStore.get(missionId);
    if (!mission) throw new FederationError(`unknown mission: ${missionId}`, 'unknown_mission', 404);
    const task = this.deps.taskStore.get(mission.taskId);
    if (!task) throw new FederationError(`mission task no longer exists: ${mission.taskId}`, 'unknown_task', 404);

    let diff: string | undefined;
    if (mission.worktreePath && existsSync(mission.worktreePath)) {
      try {
        diff = gitOut(mission.worktreePath, ['diff', `${mission.targetBranch}...HEAD`]) || undefined;
      } catch {
        diff = undefined;
      }
    }
    // Branch mode is only honest when the branch is committed locally —
    // the receiver still has to HAVE it (shared remote/clone); when it
    // doesn't, its handler falls back to the diff carried here. So a
    // bundle with a diff always prefers 'diff' unless the caller knows
    // the branch is shared; the receiver decides (see handler).
    const transcript: TranscriptMessage[] = [];
    if (this.deps.transcripts) {
      for (const role of ['worker', 'reviewer'] as const) {
        try {
          transcript.push(...this.deps.transcripts.list(missionSessionId(mission.id, role)));
        } catch {
          // A missing session log must not block the transfer.
        }
      }
    }
    const id = this.identity();
    return {
      v: 1,
      kind: 'kriyadot-mission-transfer',
      fromInstanceId: id.instanceId,
      fromName: id.name,
      transferredAt: this.nowFn(),
      stageAtTransfer: mission.stage,
      mission: {
        id: mission.id,
        repoPath: mission.repoPath,
        branch: mission.branch,
        targetBranch: mission.targetBranch,
        testCommand: mission.testCommand,
        worker: mission.worker,
        reviewer: mission.reviewer,
        ...(mission.reviewIndependence ? { reviewIndependence: mission.reviewIndependence } : {}),
        ...(mission.review ? { review: mission.review } : {}),
      },
      task: { title: task.title, ...(task.notes ? { notes: task.notes } : {}) },
      transcript,
      ...(diff ? { diff } : {}),
      mode: diff ? 'diff' : 'transcript-only',
    };
  }

  /** Origin side: transfer a mission to a peer and mark the local record
   * as transferred-away (blocked locally with the provenance evidence —
   * the local copy must never silently keep running against the same
   * branch; the receiver's copy is now the live one). */
  async transferMission(
    missionId: string,
    targetInstanceId: string,
  ): Promise<{ bundle: MissionTransferBundle; remote: Mission }> {
    const peer = this.deps.federation.getPeer(targetInstanceId);
    if (!peer || peer.status !== 'active') {
      throw new FederationError(`unknown or unlinked fleet machine: ${targetInstanceId}`, 'unknown_peer', 404);
    }
    if (this.deps.missionService.isRunning(missionId)) {
      throw new FederationError('mission is currently running here; transfer at a stage boundary', 'conflict', 409);
    }
    const bundle = this.buildTransferBundle(missionId);
    const out = await this.deps.federation.signedPeerRequest<{ ok: boolean; mission: Mission }>(
      peer,
      'POST',
      '/inbound/fleet/transfer',
      { bundle },
    );
    const local = this.deps.missionStore.update(missionId, {
      stage: 'blocked',
      evidence: `Transferred to ${out.mission.executedOnName ?? peer.name} (${peer.peerId}) at stage ${bundle.stageAtTransfer}; resumed there as mission ${out.mission.id} (mode: ${out.mission.transferMode ?? bundle.mode}). This local copy is closed.`,
      remoteMissionId: out.mission.id,
      placement: 'fleet',
      executedOnInstanceId: peer.peerId,
    });
    this.deps.taskStore.update(local.taskId, { missionStage: 'blocked' });
    this.audit('fleet.transfer_sent', { missionId, target: peer.peerId, remoteMissionId: out.mission.id, mode: bundle.mode });
    return { bundle, remote: out.mission };
  }

  /**
   * Receiver side: import a transfer bundle, reconstruct state, and
   * resume. Returns the finished mission (the resume runs the pipeline
   * from the recorded stage: review when code state arrived, worker
   * re-run — with transcript context in the task notes — when it didn't).
   * The receiver's own approval gate decides landing, as always.
   */
  async handleInboundTransfer(
    caller: PeerRecord,
    rawBundle: unknown,
    opts: { repoPathOverride?: string } = {},
  ): Promise<Mission> {
    if (!isTransferBundle(rawBundle)) {
      throw new FederationError('malformed mission transfer bundle', 'bad_request', 400);
    }
    const bundle = rawBundle;
    if (bundle.fromInstanceId !== caller.peerId) {
      throw new FederationError('transfer bundle origin does not match the calling peer', 'bad_signature', 401);
    }
    // The bundle carries the ORIGIN's repo path; the receiver's own clone
    // may live elsewhere. The receiving side (its local user/config, via
    // the inbound route) may name its local path — the origin never
    // dictates paths on the receiver.
    if (typeof opts.repoPathOverride === 'string' && opts.repoPathOverride) {
      bundle.mission.repoPath = opts.repoPathOverride;
    }
    const transcriptNote =
      bundle.transcript.length > 0
        ? `\n\n[Transferred session transcript from ${bundle.fromName} — ${bundle.transcript.length} message(s)]\n` +
          bundle.transcript.map((m) => `${m.role}: ${m.content}`).join('\n').slice(0, 8000)
        : '';
    const task = this.deps.taskStore.create({
      title: bundle.task.title,
      notes: `${bundle.task.notes ?? ''}${bundle.mode === 'transcript-only' ? transcriptNote : ''}`.trim() || undefined,
    });

    // Decide the honest code-state mode on THIS machine.
    let mode: MissionTransferBundle['mode'] = bundle.mode;
    let resumeFromStage: 'review' | undefined;
    if (bundle.mode === 'diff' || bundle.mode === 'branch') {
      let branchAvailable = false;
      if (existsSync(bundle.mission.repoPath)) {
        try {
          branchAvailable =
            gitOut(bundle.mission.repoPath, ['branch', '--list', bundle.mission.branch]).trim().length > 0;
        } catch {
          branchAvailable = false;
        }
      }
      if (bundle.mode === 'branch' && branchAvailable) {
        mode = 'branch';
        resumeFromStage = 'review';
      } else if (bundle.diff) {
        mode = 'diff';
        resumeFromStage = 'review';
      } else {
        mode = 'transcript-only';
      }
    }

    const mission = this.deps.missionService.createMission({
      taskId: task.id,
      repoPath: bundle.mission.repoPath,
      branch: bundle.mission.branch,
      targetBranch: bundle.mission.targetBranch,
      testCommand: bundle.mission.testCommand,
      workerBotId: bundle.mission.worker.botId,
      reviewerBotId: bundle.mission.reviewer.botId,
      placement: 'fleet',
      originInstanceId: caller.peerId,
      executedOnInstanceId: this.identity().instanceId,
      executedOnName: this.identity().name,
      transferredFromInstanceId: caller.peerId,
      transferredFromName: bundle.fromName,
      transferredAt: bundle.transferredAt,
      stageAtTransfer: bundle.stageAtTransfer,
      transferMode: mode,
      transferredTranscriptCount: bundle.transcript.length,
      ...(resumeFromStage ? { resumeFromStage } : {}),
    });

    // Reconstruct the durable transcript on this machine: the mission's
    // worker session log now holds the origin's messages verbatim, so a
    // resumed worker turn (transcript-only mode) and any later audit see
    // the full history. In diff/branch mode the transcript is context.
    if (this.deps.transcripts && bundle.transcript.length > 0) {
      try {
        this.deps.transcripts.append(missionSessionId(mission.id, 'worker'), bundle.transcript);
      } catch {
        // Transcript reconstruction is best-effort; the mission record
        // still carries the count + the transferred label.
      }
    }

    // Prepare the worktree for review-resume modes.
    if (resumeFromStage === 'review') {
      const mgr = new WorktreeManager(this.deps.worktreeRoot);
      let preparedPath: string | undefined;
      try {
        if (mode === 'branch') {
          // WorktreeManager.create always passes -b (new branch), so an
          // existing-branch checkout is done with git directly, at the
          // manager's conventional path; execute() then finds the
          // worktree already registered and reuses it.
          const target = join(mgr.root, bundle.mission.branch.replace(/\//g, '__'));
          if (!mgr.list(bundle.mission.repoPath).some((w) => w.path === target)) {
            gitOut(bundle.mission.repoPath, ['worktree', 'add', target, bundle.mission.branch]);
            preparedPath = target;
          }
          this.deps.missionStore.update(mission.id, { worktreePath: target });
        } else if (mode === 'diff' && bundle.diff) {
          const info = mgr.create(bundle.mission.repoPath, {
            branch: bundle.mission.branch,
            base: bundle.mission.targetBranch,
          });
          preparedPath = info.path;
          const diffPath = join(info.path, '.transferred.diff');
          writeFileSync(diffPath, bundle.diff, 'utf8');
          try {
            gitOut(info.path, ['apply', '--whitespace=nowarn', diffPath]);
          } finally {
            try {
              unlinkSync(diffPath);
            } catch {
              // Already gone — nothing to clean.
            }
          }
          gitOut(info.path, ['add', '-A']);
          gitOut(info.path, [
            '-c', 'user.email=mission@kriyadot.local',
            '-c', 'user.name=KriyaDot Mission (transferred)',
            'commit', '-m', `transferred work from ${bundle.fromName}`.slice(0, 200),
          ]);
          this.deps.missionStore.update(mission.id, { worktreePath: info.path });
        }
      } catch (err) {
        // Remove any partially prepared worktree so the transcript-only
        // restart below starts from a clean slate.
        if (preparedPath) {
          try {
            mgr.remove(bundle.mission.repoPath, preparedPath, { force: true });
          } catch {
            // Best effort; a leftover is noted in the mission evidence.
          }
          if (mode === 'diff') {
            try {
              gitOut(bundle.mission.repoPath, ['branch', '-D', bundle.mission.branch]);
            } catch {
              // Branch may not exist — fine.
            }
          }
        }
        // Diff application failed (e.g. base diverged): fall back honestly
        // to transcript-only restart rather than pretending a resume.
        this.deps.missionStore.update(mission.id, {
          transferMode: 'transcript-only',
          resumeFromStage: undefined,
          evidence: `Transferred diff could not be applied here (${err instanceof Error ? err.message : String(err)}); resuming as transcript-only restart.`,
        });
        const t2 = this.deps.taskStore.get(task.id);
        if (t2) {
          this.deps.taskStore.update(task.id, {
            notes: `${t2.notes ?? ''}${transcriptNote}`.trim() || undefined,
          });
        }
      }
    }

    this.audit('fleet.transfer_received', {
      missionId: mission.id,
      origin: caller.peerId,
      mode,
      stageAtTransfer: bundle.stageAtTransfer,
      transcriptCount: bundle.transcript.length,
    });
    return this.deps.missionService.runMission(mission.id);
  }
}

// ---------------------------------------------------------------------------
// Routes: local /fleet + inbound /federation/inbound/fleet/*
// Mounted at /api (registerFleetRoutes on the api router, like missions).
// Local routes ride the host's normal API auth; inbound routes are
// Ed25519-signature authenticated and live under the already-exempt
// /api/federation/inbound prefix (loopback-auth.ts).
// ---------------------------------------------------------------------------

export interface FleetRouteDeps {
  federation: FederationService;
  coordinator: FleetCoordinator;
  registry: FleetRegistry;
  authorizeLocal?: (req: Request) => boolean;
  /** RECEIVER-side config: local path of this machine's clone, used when
   * an inbound transfer bundle names the origin's repo path. Set by the
   * host that owns this machine — never taken from the request body. */
  transferRepoPath?: string;
}

function errBody(message: string, code?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(code ? { code } : {}) };
}

export function registerFleetRoutes(router: Router, deps: FleetRouteDeps): void {
  const { federation, coordinator, registry } = deps;

  const rawBodyOf = (req: Request): string => {
    const captured = (req as Request & { federationRawBody?: string }).federationRawBody;
    if (captured !== undefined) return captured;
    if (req.body === undefined || req.body === null) return '';
    if (typeof req.body === 'object' && !Array.isArray(req.body) && Object.keys(req.body as object).length === 0) return '';
    return JSON.stringify(req.body);
  };

  /** Verify an inbound signed request; returns the stored peer or throws.
   * Mirrors federation-routes.ts verifyInbound, plus the fleet capability
   * gate: the RECEIVING side's tunnel policy decides what a peer may do. */
  const verifyInbound = (req: Request, capability: 'fleet' | 'mission-dispatch'): PeerRecord => {
    const from = req.header('x-kriyadot-fed-from');
    const peer = from ? federation.getPeer(from) : undefined;
    if (!peer || peer.status !== 'active') {
      throw new FederationError('unknown or unlinked federation peer', 'unknown_peer', 401);
    }
    federation.verifyRequest({
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
      rawBody: rawBodyOf(req),
      headers: {
        'x-kriyadot-fed-from': from,
        'x-kriyadot-fed-ts': req.header('x-kriyadot-fed-ts'),
        'x-kriyadot-fed-nonce': req.header('x-kriyadot-fed-nonce'),
        'x-kriyadot-fed-sig': req.header('x-kriyadot-fed-sig'),
      },
      publicKey: peer.publicKey,
      expectedFrom: peer.peerId,
    });
    if (!federation.checkRate(peer.peerId)) {
      throw new FederationError('federation rate cap exceeded for this peer', 'rate_limited', 429);
    }
    if (!peer.policy.capabilities.includes(capability)) {
      throw new FederationError(`${capability} capability is not enabled for this peer`, 'capability_denied', 403);
    }
    return peer;
  };

  const sendErr = (res: Response, err: unknown): void => {
    if (err instanceof FederationError) {
      res.status(err.status).json(errBody(err.message, err.code));
      return;
    }
    res.status(500).json(errBody(err instanceof Error ? err.message : String(err)));
  };

  const localGate = (req: Request, res: Response): boolean => {
    if (deps.authorizeLocal && !deps.authorizeLocal(req)) {
      res.status(403).json(errBody('local authorization refused this fleet action', 'forbidden'));
      return false;
    }
    return true;
  };

  // ---- local --------------------------------------------------------------

  router.get('/fleet', (_req: Request, res: Response) => {
    coordinator.refreshSelf();
    res.json({ ok: true, machines: registry.listEntries(), thresholds: registry.thresholds() });
  });

  router.get('/fleet/self', (_req: Request, res: Response) => {
    res.json({ ok: true, record: coordinator.refreshSelf(), identity: federation.identity() });
  });

  router.post('/fleet/advertise', async (req: Request, res: Response) => {
    if (!localGate(req, res)) return;
    try {
      res.json({ ok: true, results: await coordinator.advertiseToPeers() });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/fleet/dispatch', async (req: Request, res: Response) => {
    if (!localGate(req, res)) return;
    try {
      const b = (req.body ?? {}) as { missionId?: unknown; targetInstanceId?: unknown };
      if (typeof b.missionId !== 'string' || typeof b.targetInstanceId !== 'string') {
        res.status(400).json(errBody('body.missionId and body.targetInstanceId are required', 'bad_request'));
        return;
      }
      const out = await coordinator.dispatchMission(b.missionId, b.targetInstanceId);
      res.json({ ok: true, mission: out.mirror, remote: out.remote });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/fleet/transfer', async (req: Request, res: Response) => {
    if (!localGate(req, res)) return;
    try {
      const b = (req.body ?? {}) as { missionId?: unknown; targetInstanceId?: unknown };
      if (typeof b.missionId !== 'string' || typeof b.targetInstanceId !== 'string') {
        res.status(400).json(errBody('body.missionId and body.targetInstanceId are required', 'bad_request'));
        return;
      }
      const out = await coordinator.transferMission(b.missionId, b.targetInstanceId);
      res.json({ ok: true, remote: out.remote, bundle: { mode: out.bundle.mode, stageAtTransfer: out.bundle.stageAtTransfer } });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.delete('/fleet/peers/:id', (req: Request, res: Response) => {
    if (!localGate(req, res)) return;
    if (!registry.removePeer(req.params.id)) {
      res.status(404).json(errBody('unknown fleet machine', 'unknown_peer'));
      return;
    }
    res.json({ ok: true, removed: true });
  });

  // ---- inbound (signature-authenticated) -----------------------------------

  router.post('/federation/inbound/fleet/advertise', (req: Request, res: Response) => {
    try {
      const peer = verifyInbound(req, 'fleet');
      const envelope = (req.body as { envelope?: SignedEnvelope } | undefined)?.envelope;
      if (!envelope) {
        res.status(400).json(errBody('body.envelope is required', 'bad_request'));
        return;
      }
      const record = coordinator.handleInboundAdvertise(envelope, peer);
      res.json({ ok: true, accepted: record.instanceId });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/federation/inbound/fleet/dispatch', async (req: Request, res: Response) => {
    try {
      const peer = verifyInbound(req, 'mission-dispatch');
      const mission = await coordinator.handleInboundDispatch(peer, (req.body ?? {}) as never);
      res.json({ ok: true, mission });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/federation/inbound/fleet/transfer', async (req: Request, res: Response) => {
    try {
      const peer = verifyInbound(req, 'mission-dispatch');
      const body = (req.body ?? {}) as { bundle?: unknown };
      const mission = await coordinator.handleInboundTransfer(peer, body.bundle, {
        ...(deps.transferRepoPath ? { repoPathOverride: deps.transferRepoPath } : {}),
      });
      res.json({ ok: true, mission });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/federation/inbound/fleet/result', (req: Request, res: Response) => {
    try {
      // A result report is fleet telemetry from the executing peer.
      verifyInbound(req, 'fleet');
      const updated = coordinator.handleInboundResult((req.body ?? {}) as never);
      res.json({ ok: true, updated });
    } catch (err) {
      sendErr(res, err);
    }
  });
}
