// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon / inject surface (Octomind parity #102 / #109, API side).
 *
 * Named sessions existed as persisted name → session records, and
 * /sessions/:id/steer could queue a message — but nothing delivered a
 * message INTO a live, already-running named session, and there was no
 * registry of which named sessions are actually alive. This module is
 * both halves of the API side:
 *
 *  - NamedSessionRegistry: the "daemon" record. The host registers a
 *    named session when a (CLI or server) process starts serving it
 *    and heartbeats while it lives; liveness is heartbeat-freshness,
 *    not a guess. Registrations expire when heartbeats stop.
 *  - createDaemonInjectRouter:
 *      POST /daemon/sessions               register { name, sessionId, pid? }
 *      POST /daemon/sessions/:name/heartbeat
 *      GET  /daemon/sessions               list with liveness
 *      DELETE /daemon/sessions/:name       unregister
 *      POST /daemon/sessions/:name/inject  { text }
 *          → if the session has a LIVE turn: enqueue as steer (the
 *            message lands at the next model-call boundary of the
 *            running turn — a true inject, not a new turn);
 *            else if the session is registered-alive: queue as steer
 *            for its next turn and say so;
 *            else: 409 — no live daemon serves that name.
 *
 * CLI INTEGRATION (the CLI half is another workstream): the `kriyadot`
 * daemon process registers itself on startup (name → its session id),
 * heartbeats every ~20s, unregisters on exit, and its chat loop drains
 * the SteerQueue at turn boundaries (runtime behaviour that already
 * exists). `kriyadot send <name> --inject` then POSTs to
 * /daemon/sessions/<name>/inject instead of starting a fresh turn.
 *
 * HOST WIRING (parent): mount at '/api' —
 *   const daemonRegistry = new NamedSessionRegistry();
 *   app.use('/api', createDaemonInjectRouter({
 *     registry: daemonRegistry,
 *     enqueueSteer: (id, text) => agentRuntime.enqueueSteer(id, text),
 *     isTurnRunning: (id) => agentRuntime.isTurnRunning(id),
 *     resolveName: (name) => namedSessionStore.get(name)?.sessionId, // optional CLI-name fallback
 *   }))
 */

import express, { type Router } from 'express';

export interface NamedSessionRecord {
  name: string;
  sessionId: string;
  pid?: number;
  registeredAt: number;
  lastHeartbeatAt: number;
}

export const DAEMON_HEARTBEAT_FRESH_MS = 60_000;

export class NamedSessionRegistry {
  private readonly records = new Map<string, NamedSessionRecord>();

  constructor(private readonly freshMs: number = DAEMON_HEARTBEAT_FRESH_MS) {}

  register(input: { name: string; sessionId: string; pid?: number }, now: number = Date.now()): NamedSessionRecord {
    const name = input.name.trim();
    if (!name) throw new Error('name is required');
    if (!input.sessionId) throw new Error('sessionId is required');
    const rec: NamedSessionRecord = {
      name, sessionId: input.sessionId, ...(input.pid ? { pid: input.pid } : {}),
      registeredAt: this.records.get(name)?.registeredAt ?? now, lastHeartbeatAt: now,
    };
    this.records.set(name, rec);
    return rec;
  }

  heartbeat(name: string, now: number = Date.now()): boolean {
    const rec = this.records.get(name);
    if (!rec) return false;
    rec.lastHeartbeatAt = now;
    return true;
  }

  unregister(name: string): boolean {
    return this.records.delete(name);
  }

  get(name: string): NamedSessionRecord | undefined {
    return this.records.get(name);
  }

  isAlive(name: string, now: number = Date.now()): boolean {
    const rec = this.records.get(name);
    return !!rec && now - rec.lastHeartbeatAt <= this.freshMs;
  }

  list(now: number = Date.now()): Array<NamedSessionRecord & { alive: boolean }> {
    return [...this.records.values()].map((r) => ({ ...r, alive: now - r.lastHeartbeatAt <= this.freshMs }));
  }

  /** Drop stale registrations (called opportunistically; bounded work). */
  prune(now: number = Date.now()): number {
    let n = 0;
    for (const [name, rec] of this.records) {
      if (now - rec.lastHeartbeatAt > this.freshMs * 10) { this.records.delete(name); n += 1; }
    }
    return n;
  }
}

export interface DaemonInjectDeps {
  registry: NamedSessionRegistry;
  enqueueSteer: (sessionId: string, text: string) => { id: string; running: boolean; pending: number };
  isTurnRunning?: (sessionId: string) => boolean;
  /** Fallback name → sessionId resolution (e.g. the CLI named-session store). */
  resolveName?: (name: string) => string | undefined;
  now?: () => number;
}

export function createDaemonInjectRouter(deps: DaemonInjectDeps): Router {
  const router = express.Router();
  const now = () => (deps.now ? deps.now() : Date.now());

  router.post('/daemon/sessions', (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; sessionId?: unknown; pid?: unknown };
    try {
      const rec = deps.registry.register({
        name: typeof body.name === 'string' ? body.name : '',
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
        pid: typeof body.pid === 'number' ? body.pid : undefined,
      }, now());
      res.status(201).json({ ok: true, session: { ...rec, alive: true } });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/daemon/sessions', (_req, res) => {
    deps.registry.prune(now());
    res.json({ ok: true, sessions: deps.registry.list(now()) });
  });

  router.post('/daemon/sessions/:name/heartbeat', (req, res) => {
    if (!deps.registry.heartbeat(req.params.name, now())) {
      res.status(404).json({ error: `no daemon session named "${req.params.name}"` });
      return;
    }
    res.json({ ok: true, name: req.params.name, alive: true });
  });

  router.delete('/daemon/sessions/:name', (req, res) => {
    if (!deps.registry.unregister(req.params.name)) {
      res.status(404).json({ error: `no daemon session named "${req.params.name}"` });
      return;
    }
    res.json({ ok: true, unregistered: req.params.name });
  });

  router.post('/daemon/sessions/:name/inject', (req, res) => {
    const text = typeof (req.body as { text?: unknown })?.text === 'string' ? (req.body as { text: string }).text.trim() : '';
    if (!text) { res.status(400).json({ error: 'text is required' }); return; }
    const rec = deps.registry.get(req.params.name);
    const sessionId = rec?.sessionId ?? deps.resolveName?.(req.params.name);
    if (!sessionId) {
      res.status(404).json({ error: `no session named "${req.params.name}"` });
      return;
    }
    const alive = rec ? deps.registry.isAlive(req.params.name, now()) : false;
    const running = deps.isTurnRunning ? deps.isTurnRunning(sessionId) : false;
    if (!alive && !running) {
      res.status(409).json({
        error: `session "${req.params.name}" is not live (no daemon heartbeat, no running turn)`,
        sessionId, alive: false,
      });
      return;
    }
    const r = deps.enqueueSteer(sessionId, text);
    res.status(202).json({
      ok: true, name: req.params.name, sessionId, steerId: r.id, pending: r.pending,
      delivery: running ? 'injected-into-live-turn' : 'queued-for-next-turn-of-live-session',
    });
  });

  return router;
}
