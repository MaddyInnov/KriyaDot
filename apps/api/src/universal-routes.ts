// SPDX-License-Identifier: Apache-2.0
// Universal Chat — REST/SSE API (mounted at /api/universal).
//
//   GET  /session → { ok, sessionId, anchorBotId, anchorBotName,
//                     chiefConfigured, attributions[] }
//        Resolves (auto-creating on first open) the caller's well-known
//        universal session. Identity comes ONLY from the verified
//        principal (principal.ts, the OPEN-1 model): a tenancy JWT / SSO
//        subject keys its own thread; the loopback owner may assert a
//        profile via x-user-id, exactly like every other scoped surface.
//   POST /chat { message, fileIds? } → SSE stream:
//        data: {type:'routing', path, botId, botName, reason, confidence,
//               via, sessionId}                      — always first
//        data: {type:'split_plan', subtasks:[{id,title}]}   — split only
//        data: {type:'notice', kind, message}        — split fallback notes
//        …then the executing turn's StreamEvents verbatim (token,
//        tool_call, tool_result, approval_required, done, …), in the
//        exact frame shapes POST /api/chat produces, so existing chat
//        rendering/governance UX applies unchanged.
//
// Execution paths (see universal.ts for the deterministic router):
//   direct     — runTurn(anchor bot, universal session)
//   specialist — runTurn(target bot, per-user shadow session) with the
//                exchange mirrored into the universal thread
//   split      — FusionOrchestrator anchored on the anchor bot; worker
//                turns are ordinary runTurn calls (approvals fail closed
//                unattended, same as /api/fusion), the fused answer is
//                appended to the universal thread and streamed back.
//
// Governance is inherited, never re-implemented: every path executes
// through the shared AgentRuntime, so approvals, hard denials, sandbox
// policy and the executing bot's own policy apply identically. The
// router itself holds no approval power — it only chooses WHO runs.
//
// Attachments: `fileIds` (uploads from POST /api/files/upload) are
// resolved to text sections and prepended to the EXECUTED message with
// exactly the /api/chat semantics (extracted text preferred, plain text
// inlined up to 100KB, anything else noted by name/type). Routing always
// decides on the user's typed text, and the universal thread mirrors the
// typed text — never the injected file bodies. One honest limit vs
// /api/chat: native vision parts are not attached on universal turns,
// so images/video arrive as presence notes (the same fallback /api/chat
// uses when the effective model cannot see media).
//
// HOST WIRING (index.ts):
//   app.use('/api/universal', createUniversalRouter({
//     dataDir: config.dataDir,
//     getBots: () => seed.bots,
//     getChiefBotId: () => chiefWiring.store.getChiefConfig().chiefBotId,
//     agentRuntime,
//     audit: (action, fields) => governance.audit(action, fields),
//     loopbackToken,
//     fusionStore,
//   }));

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import {
  FusionOrchestrator,
  InvocationDecisionLog,
  RouterDecisionLog,
  buildWorkerMessage,
  costOfUsage,
  createProvider,
  getDefaultModel,
  isProviderConfigError,
  loadRouterWeights,
  resolveViableKeylessProvider,
  type AgentRuntime,
  type BotConfig,
  type ChatMessage,
  type FusionProgressEvent,
  type FusionSubtask,
  type StreamEvent,
  type TokenUsage,
} from '@mvp/agent-runtime';
import { FusionRunStore } from './fusion.js';
import { resolvePrincipal, type Principal, type PrincipalContext } from './principal.js';
import { resolveSyncServicePrincipal } from './sync-hub.js';
import { readSyncTarget, type SyncTarget } from './sync-client.js';
import { instanceRole, type InstanceRole, type PlacementStore } from './placement.js';
import {
  UniversalChatStore,
  decideUniversalRoute,
  resolveAnchorBot,
  type UniversalRouteDecision,
} from './universal.js';

/** Mirrors routes.ts MAX_CHAT_MESSAGE_CHARS (the /api/chat cap). */
export const MAX_UNIVERSAL_MESSAGE_CHARS = 200_000;

export type UniversalLlmCaller = (
  providerId: string,
  model: string,
  messages: ChatMessage[],
) => Promise<{ content: string; usage: TokenUsage }>;

export interface UniversalRoutesDeps {
  dataDir: string;
  /** Live bot roster (seed + imports). */
  getBots: () => BotConfig[];
  /** Configured Chief of Staff bot id, or null when none is set. */
  getChiefBotId: () => string | null;
  agentRuntime: AgentRuntime;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Per-boot loopback owner token (principal resolution). */
  loopbackToken?: string;
  /** Shared store instance (host creates one; tests may omit). */
  store?: UniversalChatStore;
  /** When wired, split runs are also recorded in the Fusion run history. */
  fusionStore?: FusionRunStore;
  /** Injectable planner/fusion LLM (tests). Default: bot provider with keyless fallback. */
  callLlm?: UniversalLlmCaller;
  /**
   * Placement store (front-door Part 5). When wired, a bot whose
   * placement is 'cloud-only' is refused on a non-cloud instance (the
   * web proxies the turn to the instance instead; the API refuses to
   * execute it locally). Unset → no placement gate (previous behavior).
   */
  placementStore?: Pick<PlacementStore, 'isCloudOnly'>;
  /** This server's role for the executor gate. Default: env-derived. */
  instanceRole?: InstanceRole;
  /** Sync target for per-task cloud placement. Default: <dataDir>/sync-target.json. */
  getSyncTarget?: () => SyncTarget | null;
  /** Injectable fetch for the cloud proxy (tests stub the instance). */
  fetchFn?: (url: string, init?: Record<string, unknown>) => Promise<Awaited<ReturnType<typeof fetch>>>;
  /** Resolve a sync link-token bearer to the owner (proxied turns). Default: sync-hub helper. */
  resolveServicePrincipal?: (authorizationHeader: string | undefined) => { userId: string } | null;
}

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

type PlanFuseCall = (messages: ChatMessage[]) => Promise<{ content: string; usage: TokenUsage }>;

/** Short stable per-user key for shadow session ids (never the raw user id). */
function userKey(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 12);
}

/**
 * Resolve uploaded file ids to `[Attached file: …]` text sections and
 * prepend them to the executed message — the /api/chat semantics from
 * routes.ts (extracted text preferred, plain text inlined up to 100KB,
 * anything else noted by name/type). Best-effort: unknown or unreadable
 * ids are skipped, never an error.
 */
export function augmentMessageWithFiles(dataDir: string, message: string, fileIds: string[]): string {
  const sections: string[] = [];
  for (const fid of fileIds) {
    if (!/^[0-9a-f-]{36}$/.test(fid)) continue;
    try {
      const files = readdirSync(join(dataDir, 'uploads'));
      const match = files.find((f) => f.startsWith(`${fid}-`) && !f.endsWith('.meta.json'));
      if (!match) continue;
      const filePath = join(dataDir, 'uploads', match);
      const metaPath = `${filePath}.meta.json`;
      let name = match;
      let mimeType = 'application/octet-stream';
      let meta: { name?: string; mimeType?: string; extracted?: { units?: number; unitLabel?: string; truncated?: boolean } } = {};
      try {
        meta = JSON.parse(readFileSync(metaPath, 'utf8')) as typeof meta;
        if (meta.name) name = meta.name;
        if (meta.mimeType) mimeType = meta.mimeType;
      } catch {
        // ignore
      }
      let extractedText: string | null = null;
      try {
        extractedText = readFileSync(`${filePath}.extracted.txt`, 'utf8');
      } catch {
        // no cached extraction
      }
      if (extractedText) {
        const unitInfo = meta.extracted?.units
          ? ` (${meta.extracted.units} ${meta.extracted.unitLabel ?? 'units'})`
          : '';
        const truncNote = meta.extracted?.truncated ? '\n[Content truncated to 100KB]' : '';
        sections.push(`[Attached file: ${name}${unitInfo}]\n${extractedText}${truncNote}`);
      } else if (mimeType.startsWith('text/') || /\.(txt|md|json|js|ts|py|csv|log)$/i.test(name)) {
        const content = readFileSync(filePath, 'utf8').slice(0, 100_000);
        sections.push(`[Attached file: ${name}]\n${content}`);
      } else {
        sections.push(
          `[Attached file: ${name} (${mimeType}) — preview not available, use read_file tool to access if needed]`,
        );
      }
    } catch {
      // ignore unreadable files
    }
  }
  return sections.length > 0 ? `${sections.join('\n\n')}\n\n${message}` : message;
}

export function createUniversalRouter(deps: UniversalRoutesDeps): Router {
  const router = express.Router();
  const store = deps.store ?? new UniversalChatStore(deps.dataDir);
  const pctx: PrincipalContext = { dataDir: deps.dataDir, loopbackToken: deps.loopbackToken };

  const anchorOf = (): { anchor: BotConfig; chiefConfigured: boolean } | null => {
    const bots = deps.getBots();
    const chiefBotId = deps.getChiefBotId();
    const anchor = resolveAnchorBot(bots, chiefBotId);
    if (!anchor) return null;
    return { anchor, chiefConfigured: chiefBotId !== null && chiefBotId === anchor.id };
  };

  /** Resolve or auto-create the caller's universal session. */
  const ensureSession = (userId: string, anchor: BotConfig): string => {
    const existing = store.getSessionId(userId);
    if (existing) return existing;
    const sessionId = deps.agentRuntime.sessionStore.createSession(anchor.id);
    store.setSession(userId, sessionId, anchor.id);
    deps.audit('universal_chat.session_created', {
      actor: 'api',
      detail: { sessionId, anchorBotId: anchor.id },
    });
    return sessionId;
  };

  router.get('/session', (req: Request, res: Response) => {
    const principal = resolvePrincipal(req, pctx);
    if (!principal) {
      res.status(401).json(errorBody('unauthenticated: a verified credential is required'));
      return;
    }
    const found = anchorOf();
    if (!found) {
      res.status(503).json(errorBody('no bots are configured on this instance'));
      return;
    }
    const sessionId = ensureSession(principal.userId, found.anchor);
    res.json({
      ok: true,
      sessionId,
      anchorBotId: found.anchor.id,
      anchorBotName: found.anchor.name,
      chiefConfigured: found.chiefConfigured,
      attributions: store.listAttributions(sessionId, 50),
    });
  });

  const handleChat = async (req: Request, res: Response) => {
    // Auth: a verified principal, OR the sync link token as a service
    // credential for proxied turns (front-door Part 5) — the token maps
    // to the instance owner it was minted for, never to an asserted id.
    let principal: Principal | null = resolvePrincipal(req, pctx);
    let serviceAuthed = false;
    if (!principal) {
      const svc = (deps.resolveServicePrincipal ?? ((h: string | undefined) => resolveSyncServicePrincipal(deps.dataDir, h)))(
        req.headers.authorization,
      );
      if (svc) {
        principal = { kind: 'sso-session', userId: svc.userId, assertedProfile: false };
        serviceAuthed = true;
      }
    }
    if (!principal) {
      res.status(401).json(errorBody('unauthenticated: a verified credential is required'));
      return;
    }
    const body = (req.body ?? {}) as { message?: unknown; fileIds?: unknown; placement?: unknown };
    if (typeof body.message !== 'string' || !body.message.trim()) {
      res.status(400).json(errorBody('message is required'));
      return;
    }
    if (body.message.length > MAX_UNIVERSAL_MESSAGE_CHARS) {
      res.status(400).json(errorBody(`message exceeds ${MAX_UNIVERSAL_MESSAGE_CHARS} characters`));
      return;
    }
    const message = body.message;
    const fileIds = Array.isArray(body.fileIds)
      ? body.fileIds.filter((x): x is string => typeof x === 'string')
      : [];
    // The executed message carries the attached files' content; routing
    // and thread mirroring always use the typed text.
    const turnMessage = fileIds.length > 0 ? augmentMessageWithFiles(deps.dataDir, message, fileIds) : message;
    const found = anchorOf();
    if (!found) {
      res.status(503).json(errorBody('no bots are configured on this instance'));
      return;
    }
    const { anchor } = found;
    const bots = deps.getBots();
    const sessionId = ensureSession(principal.userId, anchor);

    // ---- Per-task cloud placement (front-door Part 5) ----
    // placement:'cloud' executes the turn on the user's cloud instance:
    // the same payload is proxied to the instance's universal endpoint
    // with the sync link token as the service credential, its SSE stream
    // is piped back verbatim, and the exchange is mirrored into the local
    // universal thread with a "(cloud)" attribution.
    if (body.placement === 'cloud') {
      const target = (deps.getSyncTarget ?? (() => readSyncTarget(deps.dataDir)))();
      if (!target) {
        res.status(409).json(errorBody('cloud-not-connected'));
        return;
      }
      await proxyCloudTurn({ deps, store, target, message, fileIds, sessionId, anchor, res, userId: principal.userId });
      return;
    }

    // ---- Route (deterministic, rules-only — see universal.ts) ----
    let decision: UniversalRouteDecision;
    try {
      decision = decideUniversalRoute(message, bots, anchor, loadRouterWeights(deps.dataDir));
    } catch {
      // Routing must never break chat: any router failure degrades to direct.
      decision = {
        path: 'direct',
        botId: anchor.id,
        botName: anchor.name,
        reason: 'router error — fell back to direct',
        confidence: 0,
        via: 'default',
      };
    }

    // Executor gate (front-door Part 5): a cloud-only bot never executes
    // on a non-cloud instance. Service-authed (proxied) turns are exempt
    // here — they ARE the cloud execution path arriving at the instance.
    if (
      !serviceAuthed &&
      deps.placementStore?.isCloudOnly(decision.botId) &&
      (deps.instanceRole ?? instanceRole()) !== 'cloud'
    ) {
      res.status(409).json({
        ok: false,
        error: 'cloud-only-bot',
        message: `${decision.botName} is cloud-only — it runs on your cloud instance, not on this device.`,
      });
      return;
    }

    // Attribution record (powers the session endpoint + Pro inspector).
    try {
      store.recordAttribution({
        sessionId,
        userId: principal.userId,
        path: decision.path,
        botId: decision.botId,
        botName: decision.botName,
        reason: decision.reason,
        confidence: decision.confidence,
        via: decision.via,
      });
    } catch {
      // Attribution is bookkeeping; never block the turn on it.
    }

    // Unified invocation decision log (kind 'routing') — the same log the
    // Octomind decision model reads; no second logger is created.
    try {
      new InvocationDecisionLog(deps.dataDir).record({
        kind: 'routing',
        subject: decision.botId,
        outcome: 'routed',
        confidence: decision.confidence,
        rationale: `[universal:${decision.path}] ${decision.reason}`,
        metadata: {
          surface: 'universal-chat',
          path: decision.path,
          via: decision.via,
          sessionId,
          anchorBotId: anchor.id,
        },
      });
      // The scored router log too, so the Routing UI shows universal picks.
      new RouterDecisionLog(deps.dataDir).record({
        ts: Date.now(),
        textHash: createHash('sha256').update(message.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex'),
        scores: [],
        winner: decision.botId,
        confidence: decision.confidence,
        reason: `[universal:${decision.path}] ${decision.reason}`,
        weightsVersion: loadRouterWeights(deps.dataDir).version,
      });
    } catch {
      // Decision logging is best-effort by design (see routing-decisions.ts).
    }

    deps.audit('universal_chat.routed', {
      actor: 'api',
      detail: {
        sessionId,
        path: decision.path,
        botId: decision.botId,
        via: decision.via,
        confidence: decision.confidence,
        messageLength: message.length,
      },
    });

    // ---- SSE stream ----
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    // NOTE: req 'close' fires as soon as the request body is consumed on
    // modern Node — it must NOT gate res.end(). Write/end decisions key
    // off the response's own state instead.
    const send = (payload: unknown): void => {
      if (res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        // A poisoned payload must not kill the stream.
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to serialize event' })}\n\n`);
        } catch {
          // socket gone
        }
      }
    };
    const forward = async (e: StreamEvent): Promise<void> => {
      send(e);
    };

    send({
      type: 'routing',
      path: decision.path,
      botId: decision.botId,
      botName: decision.botName,
      reason: decision.reason,
      confidence: decision.confidence,
      via: decision.via,
      sessionId,
    });

    try {
      if (decision.path === 'direct') {
        await deps.agentRuntime.runTurn({
          bot: anchor,
          message: turnMessage,
          sessionId,
          onEvent: forward,
        });
      } else if (decision.path === 'specialist') {
        const target = bots.find((b) => b.id === decision.botId) ?? anchor;
        // Mirror the user's message into the universal thread first so the
        // thread log stays in order; the turn itself runs in the target's
        // per-user shadow session (its own history stays continuous).
        deps.agentRuntime.sessionStore.appendMessage(sessionId, { role: 'user', content: message });
        let reply = '';
        await deps.agentRuntime.runTurn({
          bot: target,
          message: turnMessage,
          sessionId: `universal_via_${target.id}_${userKey(principal.userId)}`,
          onEvent: async (e) => {
            if (e.type === 'token') reply += e.content;
            send(e);
          },
        });
        if (reply.trim()) {
          deps.agentRuntime.sessionStore.appendMessage(sessionId, {
            role: 'assistant',
            content: reply,
          });
        }
      } else {
        await runSplit({ deps, anchor, message, taskMessage: turnMessage, sessionId, send });
      }
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // socket already gone
        }
      }
    }
  };

  router.post('/chat', handleChat);
  // Alias used by the sync proxy (front-door contract names this path).
  router.post('/message', handleChat);

  return router;
}

/**
 * Per-task cloud placement proxy: POST the same payload to the instance's
 * universal endpoint with the sync link token, stream its SSE back
 * through, and mirror the exchange into the local universal thread.
 */
async function proxyCloudTurn(args: {
  deps: UniversalRoutesDeps;
  store: UniversalChatStore;
  target: SyncTarget;
  message: string;
  fileIds: string[];
  sessionId: string;
  anchor: BotConfig;
  res: Response;
  userId: string;
}): Promise<void> {
  const { deps, store, target, message, fileIds, sessionId, anchor, res, userId } = args;
  const fetchFn = deps.fetchFn ?? ((url: string, init?: Record<string, unknown>) => fetch(url, init as RequestInit));
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetchFn(`${target.instanceUrl.replace(/\/+$/, '')}/api/universal/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.linkToken}` },
      body: JSON.stringify({ message, ...(fileIds.length > 0 ? { fileIds } : {}) }),
    });
  } catch (err) {
    res.status(502).json(errorBody(`cloud instance unreachable: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  if (!upstream.ok || !upstream.body) {
    let detail = '';
    try {
      const parsed = (await upstream.json()) as { error?: unknown };
      detail = typeof parsed.error === 'string' ? parsed.error : '';
    } catch { /* non-JSON error body */ }
    res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502).json(
      errorBody(detail || `cloud instance returned HTTP ${upstream.status}`),
    );
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  let reply = '';
  let buffer = '';
  const capture = (chunkText: string): void => {
    buffer += chunkText;
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!frame.startsWith('data: ')) continue;
      try {
        const parsed = JSON.parse(frame.slice('data: '.length)) as { type?: string; content?: string };
        if (parsed.type === 'token' && typeof parsed.content === 'string') reply += parsed.content;
      } catch { /* passthrough frames are forwarded verbatim regardless */ }
    }
  };
  try {
    const reader = (upstream.body as unknown as { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } }).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const text = decoder.decode(value, { stream: true });
        capture(text);
        if (!res.writableEnded) res.write(text);
      }
    }
  } catch (err) {
    if (!res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) })}\n\n`);
      } catch { /* socket gone */ }
    }
  } finally {
    // Mirror the exchange into the local universal thread (specialist-path
    // style: user message first, then the assistant reply), attributed
    // as a cloud execution.
    try {
      deps.agentRuntime.sessionStore.appendMessage(sessionId, { role: 'user', content: message });
      if (reply.trim()) {
        deps.agentRuntime.sessionStore.appendMessage(sessionId, { role: 'assistant', content: reply });
      }
      store.recordAttribution({
        sessionId,
        userId,
        path: 'direct',
        botId: anchor.id,
        botName: `${anchor.name} (cloud)`,
        reason: 'per-task cloud placement — executed on your cloud instance',
        confidence: 1,
        via: 'cloud',
      });
    } catch { /* mirroring is bookkeeping; the stream already delivered */ }
    if (!res.writableEnded) {
      try { res.end(); } catch { /* socket gone */ }
    }
  }
}

/**
 * SPLIT execution: FusionOrchestrator over the anchor bot, mirroring the
 * /api/fusion wiring (same unattended-approval posture, same budget caps),
 * but synchronous on this SSE stream and mirrored into the universal
 * thread. Planner/fusion LLM calls resolve through the keyless fallback
 * so a zero-key install still splits (the planner rides the free lane,
 * exactly like runTurn's own zero-setup fallback).
 */
async function runSplit(args: {
  deps: UniversalRoutesDeps;
  anchor: BotConfig;
  /** The user's typed text (mirrored into the universal thread). */
  message: string;
  /** The executed task text (message + any attached-file sections). */
  taskMessage: string;
  sessionId: string;
  send: (payload: unknown) => void;
}): Promise<void> {
  const { deps, anchor, message, taskMessage, sessionId, send } = args;
  const runtime = deps.agentRuntime;

  // Resolve the planner/fusion LLM call once. The anchor bot's own
  // provider is preferred; when it cannot be constructed for a missing
  // key (the fresh-install state), the viability-probed keyless chain
  // serves instead — the same zero-setup philosophy as runTurn, with the
  // probe so a not-running local lane is skipped rather than failing the
  // plan. Total failure degrades to a plain direct turn with a notice —
  // the user still gets an answer, never a dead thread.
  let providerId = anchor.provider ?? 'groq';
  let model = anchor.model ?? getDefaultModel(providerId) ?? 'default';
  let call: PlanFuseCall;
  if (deps.callLlm) {
    const injected = deps.callLlm;
    call = (messages) => injected(providerId, model, messages);
  } else {
    const directFallback = async (): Promise<void> => {
      send({
        type: 'notice',
        kind: 'split_unavailable',
        message: 'Split mode is unavailable (no model provider could be constructed) — answering directly instead.',
      });
      await runtime.runTurn({
        bot: anchor,
        message: taskMessage,
        sessionId,
        onEvent: async (e) => send(e),
      });
    };
    try {
      const provider = createProvider(providerId);
      call = async (messages) => {
        // Planner/fuse calls carry the whole task (and, for fusing, every
        // worker output): give them twice the usual per-call budget —
        // a 60s provider default starved the fuse step in the live
        // zero-key smoke (2026-10-30).
        const r = await provider.chat(messages, [], { model, timeoutMs: 120_000 });
        return { content: r.content, usage: r.usage };
      };
    } catch (err) {
      if (!isProviderConfigError(err)) {
        await directFallback();
        return;
      }
      const fb = await resolveViableKeylessProvider({ toolUse: false }).catch(() => null);
      if (!fb) {
        await directFallback();
        return;
      }
      providerId = fb.providerId;
      model = fb.model;
      const provider = fb.provider;
      call = async (messages) => {
        const r = await provider.chat(messages, [], { model, timeoutMs: 120_000 });
        return { content: r.content, usage: r.usage };
      };
    }
  }

  // Mirror the user's message into the universal thread (the fusion
  // workers run in their own sessions; the thread keeps the exchange).
  runtime.sessionStore.appendMessage(sessionId, { role: 'user', content: message });

  const fusionStore = deps.fusionStore;
  const record = fusionStore?.createRun({ botId: anchor.id, botName: anchor.name, task: message });
  const runKey = record?.runId ?? `u_${Date.now().toString(36)}`;
  const planTitles = new Map<string, string>();

  const emit = async (e: FusionProgressEvent): Promise<void> => {
    if (e.type === 'plan_created') {
      planTitles.clear();
      for (const s of e.plan.subtasks) planTitles.set(s.id, s.title);
      try {
        fusionStore?.setPlan(runKey, e.plan);
      } catch {
        // persistence must never break the run
      }
      send({
        type: 'split_plan',
        runId: record?.runId,
        subtasks: e.plan.subtasks.map((s) => ({ id: s.id, title: s.title })),
      });
    } else if (e.type === 'plan_failed') {
      send({
        type: 'notice',
        kind: 'split_fallback',
        message: 'Could not plan a split for this task — running it as a single task instead.',
      });
    } else if (e.type === 'done') {
      try {
        if (record) fusionStore?.completeRun(record.runId, e.result);
      } catch {
        // persistence must never break the run
      }
    }
  };

  const orchestrator = new FusionOrchestrator({
    planLlm: call,
    fuseLlm: call,
    // Cost is advisory (drives the optional budget cap): an unpriced
    // provider must degrade to 0, never crash the split.
    costOf: (usage) => {
      try {
        return costOfUsage(providerId, model, usage).total;
      } catch {
        return 0;
      }
    },
    runWorkerTurn: async (input) => {
      const workerBot: BotConfig = { ...anchor, name: `${anchor.name} (universal worker)` };
      const titleMap = new Map<string, FusionSubtask>();
      for (const [subId, title] of planTitles) {
        titleMap.set(subId, { id: subId, title, description: '', dependencies: [] });
      }
      let output = '';
      const usage = await runtime.runTurn({
        bot: workerBot,
        message: buildWorkerMessage(input.subtask, input.sharedContext, input.dependencyOutputs, titleMap),
        sessionId: `universal_fusion_${runKey}_${input.subtask.id}`,
        onEvent: (e) => {
          if (e.type === 'token') output += e.content;
        },
        // Unattended workers: approvals fail closed quickly (fusion parity).
        approvalTimeoutMs: 5000,
        maxBudgetUsd: input.maxBudgetUsd,
        signal: input.signal,
      });
      return { output: output.trim(), usage };
    },
  });

  const result = await orchestrator.run({ task: taskMessage }, emit);
  const fused = (result.fused ?? '').trim();
  if (fused) {
    send({ type: 'token', content: fused });
    runtime.sessionStore.appendMessage(sessionId, { role: 'assistant', content: fused });
  } else if (result.error) {
    send({ type: 'error', message: result.error });
  }
  send({ type: 'done', usage: result.usage ?? ZERO_USAGE });
}
