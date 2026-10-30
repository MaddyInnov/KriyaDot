// SPDX-License-Identifier: Apache-2.0
/**
 * In-session command set (Octomind parity #114, plus #88/#135/#170/
 * #172/#175/#176/#177/#178 and the #83/#86 command side).
 *
 * One dispatch — `SessionCommandService.execute(sessionId, botId, text)`
 * — backs BOTH the HTTP surface here (POST /sessions/:id/commands) and
 * the companion WebSocket surface (companion.ts routes `slash` frames
 * through the same service when the host wires it). Commands that the
 * chat route already handled (/context, /reply expansion) are not
 * duplicated; this set is the missing Octomind commands:
 *
 *   /share               → publish the session via the #169 share path
 *   /analyze             → local session viewer data (summary + context
 *                          + transcript). Loopback data only — the
 *                          endpoint returns JSON to the local client;
 *                          nothing is uploaded anywhere.
 *   /copy last|assistant|user|all
 *                        → segment text for the client to copy
 *   /done                → forced compaction (compactNow) + background
 *                          learning kickoff (runDistillPipeline when the
 *                          runtime provides it, else the upkeep capture
 *                          path — see deps and the closure report)
 *   /info                → tokens + cost + cache + compression, one view
 *   /report              → per-request usage breakdown for the session
 *   /usage               → session usage; account balance is N/A for
 *                          self-hosted BYOK (documented in the reply)
 *   /status              → workflow runs + background jobs + monitors +
 *                          shell jobs, aggregated by the host
 *   /learning list|show <id>|delete <id>|clear
 *   /learning evolution approve|reject|rollback <id>
 *   /compact             → compactNow()
 *   /new                 → start a fresh session for the same bot
 *   /schedule <when> :: <prompt>
 *                        → schedule into THIS session (#88)
 *
 * Every dependency is injectable; missing deps produce an honest
 * "not wired" reply instead of a fake success.
 *
 * HOST WIRING (parent, routes.ts — the mounts list in the report):
 *   app.use('/api', createSessionCommandsRouter(serviceDeps))
 * where serviceDeps are built from agentRuntime / stores the host owns.
 */

import express, { type Router } from 'express';
import type { IdentifiedMessage } from '@mvp/agent-runtime';
import { buildContextReport, parseScheduleCommand, selectCopySegment, type CopySegment } from './session-craft.js';

export interface SessionUsageView {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number | null;
  /** Cache figures (#137/#175): null when the provider reported none. */
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  requests?: Array<Record<string, unknown>>;
}

export interface LearningCommands {
  list: (botId: string) => Promise<unknown> | unknown;
  show: (botId: string, id: string) => Promise<unknown> | unknown;
  remove: (botId: string, id: string) => Promise<boolean> | boolean;
  clear: (botId: string) => Promise<number> | number;
  evolution: (action: 'approve' | 'reject' | 'rollback', id: string) => Promise<unknown> | unknown;
}

export interface SessionCommandDeps {
  getMessages: (sessionId: string) => IdentifiedMessage[];
  getBotId?: (sessionId: string) => string | undefined;
  listArchives?: (sessionId: string) => Array<{ id: string; messageCount: number; createdAt: string }>;
  compactNow?: (sessionId: string) => Promise<boolean>;
  shareSession?: (sessionId: string) => Promise<{ slug: string; path: string }> | { slug: string; path: string };
  /** #77 distill pipeline entry when the runtime exposes it. */
  runDistillPipeline?: (botId: string, sessionId: string) => Promise<unknown> | unknown;
  /** Fallback learning kickoff (upkeep capture) when no distill pipeline exists. */
  learningKickoff?: (botId: string, sessionId: string) => Promise<unknown> | unknown;
  usageForSession?: (sessionId: string) => Promise<SessionUsageView> | SessionUsageView;
  reportForSession?: (sessionId: string) => Promise<unknown> | unknown;
  statusAggregate?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  learning?: LearningCommands;
  createSession?: (botId: string) => string;
  scheduleIntoSession?: (
    sessionId: string,
    botId: string,
    cmd: { name: string; prompt: string; whenText: string },
  ) => Promise<unknown> | unknown;
  /**
   * Session overlays (/role, /skill): per-session role instruction and
   * pinned skills, persisted by the host (session-overlays.ts) and
   * consumed by the chat route on every turn of the session.
   */
  sessionRole?: {
    get: (sessionId: string) => string | undefined;
    set: (sessionId: string, role: string | null) => void;
  };
  sessionSkills?: {
    list: (sessionId: string) => string[];
    pin: (sessionId: string, skillName: string) => void;
    unpin: (sessionId: string, skillName: string) => boolean;
    /** All skill names the host can activate (for validation). */
    known: () => string[];
  };
}

export interface SessionCommandResult {
  handled: boolean;
  command?: string;
  reply: string;
  data?: unknown;
}

const KNOWN = ['share', 'analyze', 'copy', 'done', 'info', 'report', 'usage', 'status', 'learning', 'compact', 'new', 'schedule', 'context', 'role', 'skill'];

export class SessionCommandService {
  constructor(private readonly deps: SessionCommandDeps) {}

  isCommand(text: string): boolean {
    const m = /^\/([a-z]+)\b/.exec(text.trim());
    return !!m && KNOWN.includes(m[1]!);
  }

  async execute(sessionId: string, botId: string, text: string): Promise<SessionCommandResult> {
    const trimmed = text.trim();
    const m = /^\/([a-z]+)(?:\s+([\s\S]+))?$/.exec(trimmed);
    if (!m || !KNOWN.includes(m[1]!)) return { handled: false, reply: '' };
    const name = m[1]!;
    const args = (m[2] ?? '').trim();
    const d = this.deps;
    const messages = safe(() => d.getMessages(sessionId)) ?? [];
    switch (name) {
      case 'context': {
        const report = buildContextReport(sessionId, botId, messages, safe(() => d.listArchives?.(sessionId)) ?? []);
        return done(name, `Context: ${report.messages} messages, ~${report.estimatedHistoryTokens} estimated tokens, ${report.compactionArchives.length} compaction archive(s).`, report);
      }
      case 'share': {
        if (!d.shareSession) return done(name, '/share is not wired on this host.');
        const r = await d.shareSession(sessionId);
        return done(name, `Shared: ${r.path}`, r);
      }
      case 'analyze': {
        const report = buildContextReport(sessionId, botId, messages, safe(() => d.listArchives?.(sessionId)) ?? []);
        const data = {
          sessionId, botId, localOnly: true, uploaded: false,
          summary: { messages: report.messages, byRole: report.byRole, estimatedTokens: report.estimatedHistoryTokens },
          context: report,
          transcript: messages.map((mm) => ({ id: mm.id, role: mm.role, content: mm.content, ts: mm.ts })),
        };
        return done(name, `Local session view: ${report.messages} messages (nothing uploaded).`, data);
      }
      case 'copy': {
        const seg = (['last', 'assistant', 'user', 'all'].includes(args) ? args : 'last') as CopySegment;
        const textOut = selectCopySegment(messages, seg);
        return done(name, textOut, { segment: seg, text: textOut, chars: textOut.length });
      }
      case 'compact': {
        if (!d.compactNow) return done(name, '/compact is not wired on this host.');
        const folded = await d.compactNow(sessionId);
        return done(name, folded ? 'Compaction ran.' : 'Nothing to compact yet.', { folded });
      }
      case 'done': {
        let folded = false;
        if (d.compactNow) folded = await d.compactNow(sessionId);
        let learning: unknown = null;
        let learningVia = 'none';
        if (d.runDistillPipeline) { learning = await d.runDistillPipeline(botId, sessionId); learningVia = 'runDistillPipeline'; }
        else if (d.learningKickoff) { learning = await d.learningKickoff(botId, sessionId); learningVia = 'upkeep-capture'; }
        return done(name, `Done. Compaction ${folded ? 'ran' : 'had nothing to fold'}; learning kickoff via ${learningVia}.`, { folded, learningVia, learning });
      }
      case 'info': {
        const report = buildContextReport(sessionId, botId, messages, safe(() => d.listArchives?.(sessionId)) ?? []);
        const usage = d.usageForSession ? await d.usageForSession(sessionId) : {};
        const data = {
          sessionId, botId,
          tokens: { estimatedHistoryTokens: report.estimatedHistoryTokens, prompt: usage.promptTokens ?? null, completion: usage.completionTokens ?? null, total: usage.totalTokens ?? null },
          costUsd: usage.costUsd ?? null,
          cache: { readTokens: usage.cacheReadTokens ?? null, writeTokens: usage.cacheWriteTokens ?? null },
          compression: { archives: report.compactionArchives.length, messages: report.messages },
        };
        return done(name, `Session info: ~${report.estimatedHistoryTokens} history tokens, cost ${data.costUsd === null ? 'unknown' : `$${data.costUsd}`}, cache read ${data.cache.readTokens ?? 'n/a'}, ${data.compression.archives} compaction archive(s).`, data);
      }
      case 'report': {
        const data = d.reportForSession ? await d.reportForSession(sessionId) : (d.usageForSession ? (await d.usageForSession(sessionId)).requests ?? [] : []);
        return done(name, 'Per-request usage breakdown in the data payload.', data);
      }
      case 'usage': {
        const usage = d.usageForSession ? await d.usageForSession(sessionId) : {};
        return done(name, `Session usage: ${usage.totalTokens ?? 'unknown'} tokens, cost ${usage.costUsd == null ? 'unknown' : `$${usage.costUsd}`}. Account balance: N/A — KriyaDot is self-hosted BYOK; there is no hosted account balance, only this local usage ledger.`, { ...usage, accountBalance: null, accountBalanceNote: 'N/A for self-hosted BYOK' });
      }
      case 'status': {
        const data = d.statusAggregate ? await d.statusAggregate() : {};
        return done(name, 'Aggregated status (workflow runs, background jobs, monitors, shell jobs) in the data payload.', data);
      }
      case 'learning': {
        if (!d.learning) return done(name, '/learning is not wired on this host.');
        const [sub, rest] = splitFirst(args);
        if (sub === 'evolution') {
          const [action, id] = splitFirst(rest);
          if (!['approve', 'reject', 'rollback'].includes(action) || !id) return done(name, 'Usage: /learning evolution approve|reject|rollback <id>');
          const r = await d.learning.evolution(action as 'approve' | 'reject' | 'rollback', id);
          return done(name, `Evolution ${action}: ${id}`, r);
        }
        if (sub === 'list' || sub === '') { const r = await d.learning.list(botId); return done(name, 'Learning entries in the data payload.', r); }
        if (sub === 'show') { const r = await d.learning.show(botId, rest); return done(name, `Learning entry ${rest}`, r); }
        if (sub === 'delete') { const ok = await d.learning.remove(botId, rest); return done(name, ok ? `Deleted ${rest}.` : `No such entry ${rest}.`, { deleted: ok }); }
        if (sub === 'clear') { const n = await d.learning.clear(botId); return done(name, `Cleared ${n} learning entries.`, { cleared: n }); }
        return done(name, 'Usage: /learning list|show <id>|delete <id>|clear | /learning evolution approve|reject|rollback <id>');
      }
      case 'new': {
        if (!d.createSession) return done(name, '/new is not wired on this host.');
        const id = d.createSession(botId);
        return done(name, `New session: ${id}`, { sessionId: id });
      }
      case 'role': {
        if (!d.sessionRole) return done(name, '/role is not wired on this host.');
        if (!args) {
          const current = d.sessionRole.get(sessionId);
          return done(name, current ? `Session role: ${current}` : 'No session role set. Usage: /role <instruction> | /role clear', { role: current ?? null });
        }
        if (args.toLowerCase() === 'clear') {
          d.sessionRole.set(sessionId, null);
          return done(name, 'Session role cleared.', { role: null });
        }
        d.sessionRole.set(sessionId, args);
        return done(name, `Session role set: ${args}`, { role: args });
      }
      case 'skill': {
        if (!d.sessionSkills) return done(name, '/skill is not wired on this host.');
        const [sub, rest] = splitFirst(args);
        if (sub === '' || sub === 'list') {
          const pinned = d.sessionSkills.list(sessionId);
          return done(name, pinned.length ? `Pinned skills for this session: ${pinned.join(', ')}` : 'No skills pinned to this session. Usage: /skill <name> | /skill remove <name>', { skills: pinned });
        }
        if (sub === 'remove') {
          if (!rest) return done(name, 'Usage: /skill remove <name>');
          const ok = d.sessionSkills.unpin(sessionId, rest);
          return done(name, ok ? `Unpinned skill: ${rest}` : `Skill not pinned: ${rest}`, { skills: d.sessionSkills.list(sessionId) });
        }
        const known = d.sessionSkills.known();
        if (known.length > 0 && !known.includes(sub)) {
          return done(name, `Unknown skill "${sub}". Known skills: ${known.slice(0, 20).join(', ')}${known.length > 20 ? '…' : ''}`, { skills: d.sessionSkills.list(sessionId) });
        }
        d.sessionSkills.pin(sessionId, sub);
        return done(name, `Skill pinned to this session: ${sub}`, { skills: d.sessionSkills.list(sessionId) });
      }
      case 'schedule': {
        const cmd = parseScheduleCommand(trimmed);
        if (!cmd || !cmd.prompt) return done(name, 'Usage: /schedule <when> :: <prompt>');
        if (!d.scheduleIntoSession) return done(name, '/schedule is not wired on this host.');
        const r = await d.scheduleIntoSession(sessionId, botId, cmd);
        return done(name, `Scheduled into this session: ${cmd.prompt}`, r);
      }
      default:
        return { handled: false, reply: '' };
    }
  }
}

function done(command: string, reply: string, data?: unknown): SessionCommandResult {
  return { handled: true, command, reply, ...(data !== undefined ? { data } : {}) };
}
function safe<T>(fn: () => T | undefined): T | undefined { try { return fn(); } catch { return undefined; } }
function splitFirst(s: string): [string, string] {
  const i = s.indexOf(' ');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1).trim()];
}

export function createSessionCommandsRouter(deps: SessionCommandDeps & {
  resolveBotId?: (sessionId: string, req: express.Request) => string;
}): Router {
  const router = express.Router();
  const service = new SessionCommandService(deps);
  const botOf = (sessionId: string, req: express.Request): string =>
    deps.resolveBotId?.(sessionId, req) ?? deps.getBotId?.(sessionId) ?? (typeof req.query.botId === 'string' ? req.query.botId : '');

  router.post('/sessions/:id/commands', async (req, res) => {
    const body = (req.body ?? {}) as { command?: unknown; text?: unknown };
    const text = typeof body.command === 'string' ? body.command : typeof body.text === 'string' ? body.text : '';
    if (!text) { res.status(400).json({ error: 'command (string) is required' }); return; }
    try {
      const result = await service.execute(req.params.id, botOf(req.params.id, req), text);
      if (!result.handled) { res.status(400).json({ error: `unknown session command: ${text.split(/\s/)[0]}` }); return; }
      res.json({ ok: true, ...result });
    } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
  });

  // /analyze viewer data (#170): loopback client fetches this; nothing leaves the machine.
  router.get('/sessions/:id/analyze', async (req, res) => {
    try {
      const result = await service.execute(req.params.id, botOf(req.params.id, req), '/analyze');
      res.json({ ok: true, ...result });
    } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
  });

  router.get('/sessions/:id/copy', async (req, res) => {
    const seg = typeof req.query.segment === 'string' ? req.query.segment : 'last';
    try {
      const result = await service.execute(req.params.id, botOf(req.params.id, req), `/copy ${seg}`);
      res.json({ ok: true, ...result });
    } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
  });

  return router;
}

/** Factory returning the service itself (WS/companion wiring uses this). */
export function createSessionCommandService(deps: SessionCommandDeps): SessionCommandService {
  return new SessionCommandService(deps);
}
