// SPDX-License-Identifier: Apache-2.0
// ACP (Agent Client Protocol) session API (OpenMausBot parity P1 #26 —
// ACP completion).
//
//   GET    /                          → { ok, sessions }
//   POST   /                          → { ok, session }          (create + connect)
//   GET    /:id                       → { ok, session, transcript }
//   POST   /:id/resume                → { ok, session }
//   POST   /:id/prompt  {text}        → text/event-stream of AcpStreamEvent
//   POST   /:id/cancel                → { ok, cancelled }
//   DELETE /:id                       → { ok }                   (close)
//
// Trust model: the external agent is UNTRUSTED. Its tool calls never
// execute locally — approving one means "the agent may perform this action
// itself in its own process"; the verdict (+ a proceed note) flows back via
// tool_result. Denials/timeouts fail closed.
//
// HOST WIRING (index.ts — this module is not mounted by itself):
//   import { createAcpSessionsRouter } from './acp-sessions-routes.js';
//   import { AcpSessionManager, AcpSessionStore } from '@mvp/agent-runtime';
//   const acpStore = new AcpSessionStore(config.dataDir);
//   const acpManager = new AcpSessionManager(acpStore);
//   app.use('/api/acp', createAcpSessionsRouter({
//     manager: acpManager,
//     workspaceDir: config.workspaceDir,
//     governance,
//     audit: (action, fields) => governance.audit(action, fields),
//   }));

import express, { type Router } from 'express';
import {
  acpEngineSessionOptions,
  detectAcpEngines,
  getAcpEnginePreset,
  listAcpEnginePresets,
  type AcpSessionManager,
  type AcpToolCall,
  type AcpToolVerdict,
  type AcpStreamEvent,
} from '@mvp/agent-runtime';

export interface AcpSessionsDeps {
  manager: AcpSessionManager;
  /** Workspace root — external agents are spawned with cwd confined here. */
  workspaceDir: string;
  governance: {
    requestApproval(toolName: string, args: Record<string, unknown>, ctx: { sessionId: string; botId: string; actor: string }): string;
    awaitDecision(approvalId: string, timeoutMs: number): Promise<string>;
  };
  audit: (action: string, fields: { actor?: string; sessionId?: string; detail?: unknown }) => void;
  /** Standalone engine installs: an installed build's path wins over PATH. */
  standalonePath?: (engineId: string) => string | null;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

function sseWrite(res: { write(s: string): void }, event: AcpStreamEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createAcpSessionsRouter(deps: AcpSessionsDeps): Router {
  const router = express.Router();
  const { manager } = deps;

  /** Offer an agent-requested tool call to the human via the approvals inbox. */
  const requestToolApproval = async (sessionId: string, toolCall: AcpToolCall): Promise<AcpToolVerdict> => {
    const approvalId = deps.governance.requestApproval(
      `acp.tool:${toolCall.name}`,
      {
        acpSession: sessionId,
        toolCallId: toolCall.toolCallId,
        name: toolCall.name,
        args: toolCall.args,
        note: 'The external ACP agent wants to perform this action itself. Approving lets it proceed in its own process; nothing executes inside KriyaDot.',
      },
      { sessionId, botId: 'acp', actor: 'acp' },
    );
    try {
      const verdict = await deps.governance.awaitDecision(approvalId, 120_000);
      if (verdict === 'approved') {
        deps.audit('acp.tool_call_approved', { actor: 'user', sessionId, detail: { toolCallId: toolCall.toolCallId, name: toolCall.name } });
        return { approved: true, output: 'Approved by the user — proceed with the action in your own environment.' };
      }
      deps.audit('acp.tool_call_denied', { actor: 'user', sessionId, detail: { toolCallId: toolCall.toolCallId, name: toolCall.name } });
      return { approved: false, error: 'Denied by the user.' };
    } catch {
      return { approved: false, error: 'Approval timed out — denied.' };
    }
  };

  /** List sessions. */
  router.get('/', (_req, res) => {
    res.json({ ok: true, sessions: manager.listSessions() });
  });

  /** Built-in ACP engine presets (W9) + live detection for the ACP panel. */
  router.get('/engines', (_req, res) => {
    const detected = new Map(detectAcpEngines({ standalonePath: deps.standalonePath }).map((d) => [d.id, d] as const));
    res.json({
      ok: true,
      engines: listAcpEnginePresets().map((p) => ({
        id: p.id,
        name: p.name,
        command: p.command,
        args: p.acpArgs,
        authId: p.authId ?? null,
        models: p.models,
        notes: p.notes,
        installed: detected.get(p.id)?.installed ?? false,
      })),
    });
  });

  /** Create + connect a session. */
  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as { command?: unknown; args?: unknown; label?: unknown; engine?: unknown };
    // W9: { engine: 'copilot' } creates a session from the built-in preset
    // (command/args may still override the preset for non-PATH installs).
    if (typeof body.engine === 'string' && body.engine.trim()) {
      const engineId = body.engine.trim();
      if (!getAcpEnginePreset(engineId)) {
        res.status(400).json(errorBody(`Unknown ACP engine "${engineId}".`));
        return;
      }
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : undefined;
      try {
        const session = await manager.createSession(
          acpEngineSessionOptions(engineId, {
            cwd: deps.workspaceDir,
            ...(label ? { label } : {}),
            ...(typeof body.command === 'string' && body.command.trim() ? { command: body.command.trim() } : {}),
            ...(Array.isArray(body.args)
              ? { args: body.args.filter((a): a is string => typeof a === 'string').slice(0, 32) }
              : {}),
          }),
        );
        deps.audit('acp.session_created', {
          actor: 'user',
          sessionId: session.id,
          detail: { engine: engineId, command: session.command, label: session.label, agent: session.agentName },
        });
        res.status(201).json({ ok: true, session });
      } catch (err) {
        const e = err as { kind?: string; message?: string };
        res.status(502).json(errorBody(e?.message ?? 'Failed to start the external agent.', e?.kind));
      }
      return;
    }
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!command) {
      res.status(400).json(errorBody('command is required (or name a built-in "engine", e.g. "copilot")'));
      return;
    }
    if (command.length > 500) {
      res.status(400).json(errorBody('command is too long (max 500 characters)'));
      return;
    }
    const args = Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === 'string').slice(0, 32).map((a) => a.slice(0, 500)) : [];
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : undefined;
    try {
      const session = await manager.createSession({ command, args, ...(label ? { label } : {}), cwd: deps.workspaceDir });
      deps.audit('acp.session_created', { actor: 'user', sessionId: session.id, detail: { command, label: session.label, agent: session.agentName } });
      res.status(201).json({ ok: true, session });
    } catch (err) {
      const e = err as { kind?: string; message?: string };
      res.status(502).json(errorBody(e?.message ?? 'Failed to start the external agent.', e?.kind));
    }
  });

  /** Session detail + transcript. */
  router.get('/:id', (req, res) => {
    try {
      const session = manager.getSession(req.params.id);
      const transcript = manager.getTranscript(req.params.id);
      res.json({ ok: true, session, transcript });
    } catch (err) {
      const e = err as { kind?: string; message?: string };
      res.status(e?.kind === 'not-found' ? 404 : 500).json(errorBody(e?.message ?? 'Unknown error'));
    }
  });

  /** Resume (reconnect) a session. */
  router.post('/:id/resume', async (req, res) => {
    try {
      const session = await manager.resumeSession(req.params.id);
      deps.audit('acp.session_resumed', { actor: 'user', sessionId: session.id });
      res.json({ ok: true, session });
    } catch (err) {
      const e = err as { kind?: string; message?: string };
      const status = e?.kind === 'not-found' ? 404 : e?.kind === 'closed' ? 409 : 502;
      res.status(status).json(errorBody(e?.message ?? 'Unknown error', e?.kind));
    }
  });

  /** Stream a prompt as SSE. */
  router.post('/:id/prompt', async (req, res) => {
    const body = (req.body ?? {}) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      res.status(400).json(errorBody('text is required'));
      return;
    }
    const id = req.params.id;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': acp prompt stream\n\n');
    let ended = false;
    const end = (): void => {
      if (!ended) {
        ended = true;
        res.end();
      }
    };
    req.on('close', () => {
      // The user navigated away mid-turn — cancel the in-flight prompt so
      // the external agent doesn't keep burning.
      try {
        manager.cancelPrompt(id);
      } catch {
        // ignore
      }
      end();
    });
    try {
      await manager.prompt(id, text, {
        onEvent: (e) => {
          try {
            sseWrite(res, e);
          } catch {
            // client gone
          }
        },
        requestToolApproval: (tc) => requestToolApproval(id, tc),
      });
    } catch (err) {
      const e = err as { kind?: string; message?: string };
      const kind = e?.kind;
      if (kind === 'not-found') {
        try {
          sseWrite(res, { type: 'error', kind: 'not-found', message: e?.message ?? 'Session not found.' });
        } catch {
          // ignore
        }
      } else if (kind === 'busy') {
        try {
          sseWrite(res, { type: 'error', kind: 'busy', message: e?.message ?? 'Session is busy.' });
        } catch {
          // ignore
        }
      }
      // cancelled / timeout / agent-error / disconnected already emitted
      // their own stream events by the manager.
    } finally {
      end();
    }
  });

  /** Cancel the in-flight prompt. */
  router.post('/:id/cancel', (req, res) => {
    try {
      const cancelled = manager.cancelPrompt(req.params.id);
      res.json({ ok: true, cancelled });
    } catch (err) {
      const e = err as { kind?: string; message?: string };
      res.status(e?.kind === 'not-found' ? 404 : 500).json(errorBody(e?.message ?? 'Unknown error'));
    }
  });

  /** Close a session. */
  router.delete('/:id', async (req, res) => {
    try {
      await manager.closeSession(req.params.id);
      deps.audit('acp.session_closed', { actor: 'user', sessionId: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      const e = err as { kind?: string; message?: string };
      res.status(e?.kind === 'not-found' ? 404 : 500).json(errorBody(e?.message ?? 'Unknown error'));
    }
  });

  return router;
}
