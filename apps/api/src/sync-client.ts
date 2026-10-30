// SPDX-License-Identifier: Apache-2.0
// Sync client engine (front-door Part 4): when a sync target is configured
// (the user's own cloud instance URL + link token — set by cloud deploy
// provisioning or POST /api/sync/target), this engine
//   (a) pushes local sessions/bots/routines UP to the instance,
//   (b) pulls remote changes DOWN into the local sync store (the unified
//       history cache /api/sync/history reads),
//   (c) records this instance's OWN sessions into its own sync store so a
//       cloud instance holds its cloud-origin sessions for others to pull,
//   (d) queues failed pushes in a persistent outbox and retries them.
//
// Change detection is a simple 15s-interval dirty check: per-session max
// pushed rowId watermarks persisted in the local sync store's meta table.
// Sessions of localOnly bots are never pushed and never self-recorded.

import fs from 'node:fs';
import path from 'node:path';
import type { SessionStore } from '@mvp/agent-runtime';
import type { BotConfig } from '@mvp/agent-runtime';
import { SyncHubStore, type SyncPushPayload, type SyncOrigin } from './sync-hub.js';
import type { PlacementStore } from './placement.js';
import type { BotRoutine } from './bot-routines.js';

export interface SyncTarget {
  instanceUrl: string;
  linkToken: string;
}

export function syncTargetPath(dataDir: string): string {
  return path.join(dataDir, 'sync-target.json');
}

export function readSyncTarget(dataDir: string): SyncTarget | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncTargetPath(dataDir), 'utf8')) as SyncTarget;
    if (!parsed.instanceUrl || !parsed.linkToken) return null;
    return { instanceUrl: parsed.instanceUrl.replace(/\/+$/, ''), linkToken: parsed.linkToken };
  } catch {
    return null;
  }
}

export function writeSyncTarget(dataDir: string, target: SyncTarget): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = syncTargetPath(dataDir);
  fs.writeFileSync(
    file,
    JSON.stringify({ instanceUrl: target.instanceUrl.replace(/\/+$/, ''), linkToken: target.linkToken, updatedAt: Date.now() }, null, 2),
    { mode: 0o600 },
  );
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function clearSyncTarget(dataDir: string): void {
  try { fs.rmSync(syncTargetPath(dataDir), { force: true }); } catch { /* already gone */ }
}

export type SyncFetchFn = (
  url: string,
  init?: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

/**
 * Default sync fetch with a hard timeout. The engine tick is serialized
 * (push then pull), so an unbounded fetch to a dead socket — routine
 * after the instance restarts — would wedge ALL sync for as long as TCP
 * takes to give up (minutes). A bounded fetch fails the tick fast; the
 * outbox + next tick recover on their own.
 */
export const SYNC_FETCH_TIMEOUT_MS = 15_000;

export function createDefaultSyncFetch(timeoutMs: number = SYNC_FETCH_TIMEOUT_MS): SyncFetchFn {
  return (url, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const caller = (init as RequestInit | undefined)?.signal;
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    return fetch(url, { ...(init as RequestInit), signal }) as unknown as ReturnType<SyncFetchFn>;
  };
}

const defaultFetch: SyncFetchFn = createDefaultSyncFetch();

export interface SyncClientDeps {
  dataDir: string;
  store: SyncHubStore;
  sessionStore: Pick<SessionStore, 'listSessions' | 'listThreadMessages'>;
  getBots: () => BotConfig[];
  placementStore?: PlacementStore;
  getRoutines?: () => BotRoutine[];
  /** Origin label for THIS side's own sessions ('local' device / 'cloud' instance). */
  origin?: SyncOrigin;
  fetchFn?: SyncFetchFn;
  now?: () => number;
  /**
   * Apply-on-receive hook for pulled definitions (sync-apply.ts): pulled
   * routines whose anchor designates THIS server get imported live.
   * Failures are swallowed by the engine's tick error handling.
   */
  applyPulled?: (items: { routines?: SyncPushPayload['routines']; bots?: SyncPushPayload['bots'] }) => void;
}

interface SyncClientState {
  lastPushAt: number | null;
  lastPullAt: number | null;
  lastError?: string;
}

export class SyncClientEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private state: SyncClientState = { lastPushAt: null, lastPullAt: null };

  constructor(private readonly deps: SyncClientDeps) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath(), 'utf8')) as SyncClientState;
      this.state = { lastPushAt: parsed.lastPushAt ?? null, lastPullAt: parsed.lastPullAt ?? null, lastError: parsed.lastError };
    } catch { /* fresh */ }
  }

  private statePath(): string {
    return path.join(this.deps.dataDir, 'sync-client-state.json');
  }

  private saveState(): void {
    try { fs.writeFileSync(this.statePath(), JSON.stringify(this.state), { mode: 0o600 }); } catch { /* best effort */ }
  }

  get target(): SyncTarget | null {
    return readSyncTarget(this.deps.dataDir);
  }

  get configured(): boolean {
    return this.target !== null;
  }

  status(): {
    configured: boolean;
    instanceUrl?: string;
    lastPushAt: number | null;
    lastPullAt: number | null;
    pendingOutbox: number;
    lastError?: string;
  } {
    const t = this.target;
    return {
      configured: !!t,
      ...(t ? { instanceUrl: t.instanceUrl } : {}),
      lastPushAt: this.state.lastPushAt,
      lastPullAt: this.state.lastPullAt,
      pendingOutbox: this.deps.store.outboxCount(),
      ...(this.state.lastError ? { lastError: this.state.lastError } : {}),
    };
  }

  private origin(): SyncOrigin {
    return this.deps.origin ?? 'local';
  }

  private isLocalOnlyBot(botId: string): boolean {
    return this.deps.placementStore?.isLocalOnly(botId) ?? false;
  }

  /**
   * Collect sessions with messages newer than the pushed watermark for
   * the given watermark namespace ('push' | 'self'). Bots flagged
   * localOnly are skipped entirely.
   */
  private collectSessions(ns: 'push' | 'self'): { payload: SyncPushPayload; watermarks: Array<{ sessionId: string; maxRowId: number }> } {
    const sessions: NonNullable<SyncPushPayload['sessions']> = [];
    const watermarks: Array<{ sessionId: string; maxRowId: number }> = [];
    let summaries: ReturnType<SyncClientDeps['sessionStore']['listSessions']> = [];
    try {
      summaries = this.deps.sessionStore.listSessions({ limit: 200 });
    } catch {
      summaries = [];
    }
    for (const s of summaries) {
      if (this.isLocalOnlyBot(s.botId)) continue;
      const wmKey = `${ns}Watermark:${s.id}`;
      const wmRaw = this.deps.store.getMeta(wmKey);
      const wm = wmRaw === undefined ? -1 : Number(wmRaw) || 0;
      let messages: ReturnType<SyncClientDeps['sessionStore']['listThreadMessages']> = [];
      try {
        messages = this.deps.sessionStore.listThreadMessages(s.id);
      } catch {
        messages = [];
      }
      const fresh = messages.filter((m) => m.id > wm);
      if (wm !== -1 && fresh.length === 0) continue;
      const maxRowId = messages.reduce((acc, m) => Math.max(acc, m.id), wm);
      sessions.push({
        sessionId: s.id,
        botId: s.botId,
        origin: this.origin(),
        originInstanceId: this.deps.store.instanceId,
        messages: fresh.map((m) => ({
          rowId: m.id,
          role: m.role,
          content: m.content,
          ts: m.ts,
          ...(m.toolName ? { toolName: m.toolName } : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
          ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        })),
      });
      watermarks.push({ sessionId: s.id, maxRowId });
    }
    return { payload: { sessions }, watermarks };
  }

  private fullPayload(ns: 'push' | 'self'): { payload: SyncPushPayload; watermarks: Array<{ sessionId: string; maxRowId: number }> } {
    const { payload, watermarks } = this.collectSessions(ns);
    const bots = this.deps.getBots();
    payload.bots = bots
      .filter((b) => !this.isLocalOnlyBot(b.id))
      .map((b) => {
        const rec = this.deps.placementStore?.getBot(b.id);
        const executorHere =
          this.origin() === 'cloud'
            ? rec?.placement !== 'local'
            : rec?.placement === 'cloud-report' || rec?.placement === 'cloud-only';
        return {
          botId: b.id,
          config: b as unknown as Record<string, unknown>,
          ...(rec ? { placement: rec.placement } : {}),
          executorHere,
        };
      });
    const routines = this.deps.getRoutines?.() ?? [];
    if (routines.length > 0) {
      payload.routines = routines.map((r) => ({
        routineId: r.id,
        def: r as unknown as Record<string, unknown>,
        ...(r.anchor ? { anchor: r.anchor } : {}),
      }));
    }
    return { payload, watermarks };
  }

  private markWatermarks(ns: 'push' | 'self', watermarks: Array<{ sessionId: string; maxRowId: number }>): void {
    for (const w of watermarks) this.deps.store.setMeta(`${ns}Watermark:${w.sessionId}`, String(w.maxRowId));
  }

  /** Record this instance's own sessions into its own sync store. */
  recordSelfSessions(): { sessions: number; messages: number } {
    const { payload, watermarks } = this.fullPayload('self');
    const counts = this.deps.store.mergePush(payload, { defaultOriginInstance: this.deps.store.instanceId });
    this.markWatermarks('self', watermarks);
    return counts;
  }

  private async post(pathname: string, body: unknown): Promise<void> {
    const t = this.target;
    if (!t) throw new Error('sync target is not configured');
    const res = await (this.deps.fetchFn ?? defaultFetch)(`${t.instanceUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.linkToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`sync ${pathname} failed: HTTP ${res.status}`);
  }

  /** Push one arbitrary payload to the instance now (placement flips). */
  async pushPayloadNow(payload: SyncPushPayload): Promise<void> {
    await this.post('/api/sync/push', payload);
    this.state.lastPushAt = this.deps.now?.() ?? Date.now();
    delete this.state.lastError;
    this.saveState();
  }

  /** Flush the outbox, then push fresh local changes. Throws on failure. */
  async pushNow(): Promise<{ pushed: boolean; outboxFlushed: number }> {
    const t = this.target;
    if (!t) return { pushed: false, outboxFlushed: 0 };
    // Outbox first (oldest queued batches), each removed only on success.
    let flushed = 0;
    for (const item of this.deps.store.listOutbox()) {
      try {
        await this.post('/api/sync/push', item.payload);
        this.deps.store.removeOutbox(item.id);
        flushed += 1;
      } catch (err) {
        this.deps.store.bumpOutbox(item.id);
        throw err;
      }
    }
    const { payload, watermarks } = this.fullPayload('push');
    const hasContent = (payload.sessions?.length ?? 0) > 0 || (payload.bots?.length ?? 0) > 0 || (payload.routines?.length ?? 0) > 0;
    if (!hasContent) return { pushed: flushed > 0, outboxFlushed: flushed };
    try {
      await this.post('/api/sync/push', payload);
    } catch (err) {
      // Persistent outbox: the failed batch stays queued for the next tick.
      this.deps.store.enqueueOutbox(payload);
      throw err;
    }
    this.markWatermarks('push', watermarks);
    this.state.lastPushAt = this.deps.now?.() ?? Date.now();
    delete this.state.lastError;
    this.saveState();
    return { pushed: true, outboxFlushed: flushed };
  }

  /** Pull remote changes into the local sync store. Throws on failure. */
  async pullNow(): Promise<{ pulled: boolean; cursor: number }> {
    const t = this.target;
    if (!t) return { pulled: false, cursor: Number(this.deps.store.getMeta('pullCursor') ?? 0) || 0 };
    const since = Number(this.deps.store.getMeta('pullCursor') ?? 0) || 0;
    const res = await (this.deps.fetchFn ?? defaultFetch)(`${t.instanceUrl}/api/sync/pull?since=${since}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${t.linkToken}` },
    });
    if (!res.ok) throw new Error(`sync pull failed: HTTP ${res.status}`);
    const data = (await res.json()) as {
      sessions?: SyncPushPayload['sessions'];
      bots?: SyncPushPayload['bots'];
      routines?: SyncPushPayload['routines'];
      activity?: SyncPushPayload['activity'];
      items?: { sessions?: SyncPushPayload['sessions']; bots?: SyncPushPayload['bots']; routines?: SyncPushPayload['routines']; activity?: SyncPushPayload['activity'] };
      cursor?: number;
    };
    const body = data.items ?? data;
    this.deps.store.mergePush({
      sessions: body.sessions ?? [],
      bots: body.bots ?? [],
      routines: body.routines ?? [],
      activity: body.activity ?? [],
    });
    try {
      this.deps.applyPulled?.({ routines: body.routines ?? [], bots: body.bots ?? [] });
    } catch {
      // Apply-on-receive must not break sync; the merge above is durable.
    }
    const cursor = typeof data.cursor === 'number' ? data.cursor : since;
    this.deps.store.setMeta('pullCursor', String(cursor));
    this.state.lastPullAt = this.deps.now?.() ?? Date.now();
    delete this.state.lastError;
    this.saveState();
    return { pulled: true, cursor };
  }

  /** One engine tick: self-record, push (with outbox), pull. Never throws. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      try { this.recordSelfSessions(); } catch { /* self-record must not break sync */ }
      if (this.configured) {
        await this.pushNow();
        await this.pullNow();
      }
    } catch (err) {
      this.state.lastError = err instanceof Error ? err.message : String(err);
      this.saveState();
    } finally {
      this.ticking = false;
    }
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    void this.tick(); // boot sync
    this.timer = setInterval(() => void this.tick(), intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) (this.timer as { unref: () => void }).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
