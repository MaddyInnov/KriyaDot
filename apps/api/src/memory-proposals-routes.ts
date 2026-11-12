// SPDX-License-Identifier: Apache-2.0
/**
 * Memory pipeline routes (A10, Timon parity programme): the proposals
 * inbox for synthesized candidate rules, the manual synthesis trigger,
 * and the user-only decision endpoint.
 *
 *   GET  /proposals?botId[&status=pending|approved|dismissed|all]
 *   POST /proposals/synthesize        { botId }            → run one synthesis pass now
 *   POST /proposals/:id/decide        { botId, action: 'approve'|'dismiss', text? }
 *
 * Why the decision endpoint is gated differently from the other memory
 * routes (reasoning / threat model): approving a proposal mints a
 * standing instruction every future turn will follow. That is a
 * privilege-escalation-shaped action — if a bot (or any non-user caller)
 * could approve, the capture→promotion pipeline would be a
 * prompt-injection persistence layer. So decide (and the manual
 * synthesize trigger, which writes inbox candidates) requires a VERIFIED
 * principal (principal.ts, OPEN-1): tenancy JWT, SSO session, or the
 * loopback owner credential. `x-user-id` alone NEVER authorizes — under
 * OPEN-1 it is profile selection, honoured only as the owner principal's
 * asserted profile, and the recorded `decidedBy` is the principal's
 * verified user id, never a raw client-supplied value. When the router
 * is mounted without a principal context (standalone/test mounts), the
 * host's loopback auth upstream is the boundary — the same posture as
 * the sibling memory routers — and decisions record 'local-user'.
 *
 * Honest limits: in the single-owner local deployment the loopback
 * owner IS the user, so "user-only" means "holder of a verified
 * credential for this install". There is no per-human multi-user
 * separation inside one owner profile, and none is claimed.
 *
 * HOST WIRING (routes.ts — the main router mounts this at /memory):
 *   router.use('/memory', createMemoryProposalsRouter({
 *     tieredMemoryStore,
 *     getBots: () => bots.map((b) => ({ id: b.id })),
 *     getBotById: (id) => bots.find((b) => b.id === id),
 *     principalContext: { dataDir: config.dataDir },
 *   }));
 */

import express, { type Router } from 'express';
import {
  createModelRuleSynthesizer,
  synthesizeRuleProposals,
  type BotConfig,
  type RuleSynthesizer,
  type TieredMemoryStore,
} from '@mvp/agent-runtime';
import { buildBotChatFn } from './memory-fabric.js';
import { requirePrincipal, type PrincipalContext } from './principal.js';

export interface MemoryProposalsRouterDeps {
  tieredMemoryStore: TieredMemoryStore;
  getBots: () => Array<{ id: string }>;
  /** Full bot lookup so the manual trigger can use the bot's own model lane. Optional. */
  getBotById?: (botId: string) => BotConfig | undefined;
  /**
   * OPEN-1 principal context (data dir for SSO sessions; loopback token
   * for standalone mounts). When provided, decide/synthesize REQUIRE a
   * verified principal. When absent, the upstream loopback boundary is
   * trusted (sibling memory routers' posture).
   */
  principalContext?: PrincipalContext;
  /** Injectable synthesizer factory (tests mock the model lane; zero paid API use). */
  synthesizerForBot?: (bot: BotConfig | undefined, botId: string) => RuleSynthesizer | undefined;
  /** Audit sink (host wires governance.audit). Optional. */
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export function createMemoryProposalsRouter(deps: MemoryProposalsRouterDeps): Router {
  const router = express.Router();
  const store = deps.tieredMemoryStore;

  const requireBotId = (raw: unknown): string => {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('"botId" is required');
    const id = raw.trim();
    if (!deps.getBots().some((b) => b.id === id)) throw new Error(`Unknown bot "${id}"`);
    return id;
  };

  /**
   * The deciding user for this request, or null after sending 401.
   * With a principal context: the VERIFIED principal's user id (OPEN-1 —
   * x-user-id is never read here as authorization). Without one: the
   * local-owner fallback label.
   */
  const decidingUser = (req: express.Request, res: express.Response): string | null => {
    if (!deps.principalContext) return 'local-user';
    const principal = requirePrincipal(req, res, deps.principalContext);
    return principal ? principal.userId : null;
  };

  const synthesizerFor = (botId: string): RuleSynthesizer | undefined => {
    if (deps.synthesizerForBot) {
      return deps.synthesizerForBot(deps.getBotById?.(botId), botId);
    }
    const bot = deps.getBotById?.(botId);
    if (!bot) return undefined;
    const chat = buildBotChatFn(bot);
    return chat ? createModelRuleSynthesizer(chat) : undefined;
  };

  // List the inbox. Read-only: any caller the host lets reach the memory
  // routes may view proposals (same posture as listing atoms).
  router.get('/proposals', (req, res) => {
    const botIdRaw = typeof req.query.botId === 'string' ? req.query.botId : '';
    let botId: string;
    try {
      botId = requireBotId(botIdRaw);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const status = statusRaw === 'approved' || statusRaw === 'dismissed' || statusRaw === 'all' ? statusRaw : 'pending';
    try {
      res.json({ ok: true, botId, status, proposals: store.listRuleProposals(botId, status) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list rule proposals', err instanceof Error ? err.message : String(err)));
    }
  });

  // Manual "synthesize now" trigger (the scheduled routine lives in
  // memory-upkeep-routes.ts startMemoryUpkeep). User-gated: it writes
  // inbox state and may spend the bot's model tokens.
  router.post('/proposals/synthesize', async (req, res) => {
    const user = decidingUser(req, res);
    if (!user) return; // 401 already sent
    let botId: string;
    try {
      botId = requireBotId((req.body as { botId?: unknown })?.botId);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    try {
      const result = await synthesizeRuleProposals(store, botId, { synthesizer: synthesizerFor(botId) });
      deps.audit?.('memory.rule_synthesis', { actor: user, detail: { botId, created: result.created.length, lane: result.lane } });
      res.json({ ok: true, botId, created: result.created, skipped: result.skipped, lane: result.lane });
    } catch (err) {
      res.status(500).json(errorBody('Synthesis failed', err instanceof Error ? err.message : String(err)));
    }
  });

  // THE approval gate: approve / edit-then-approve / dismiss. User-only
  // (verified principal when a context is wired). Bots have no route to
  // this: no tool exposes it, and the decision records who decided.
  router.post('/proposals/:id/decide', (req, res) => {
    const user = decidingUser(req, res);
    if (!user) return; // 401 already sent
    const body = (req.body ?? {}) as { botId?: unknown; action?: unknown; text?: unknown };
    let botId: string;
    try {
      botId = requireBotId(body.botId);
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Invalid request'));
      return;
    }
    if (body.action !== 'approve' && body.action !== 'dismiss') {
      res.status(400).json(errorBody('Body must be { botId, action: "approve" | "dismiss", text?: string }'));
      return;
    }
    if (body.text !== undefined && typeof body.text !== 'string') {
      res.status(400).json(errorBody('"text" must be a string when provided'));
      return;
    }
    try {
      const proposal = store.decideRuleProposal(botId, req.params.id, {
        action: body.action,
        ...(body.action === 'approve' && typeof body.text === 'string' ? { editedText: body.text } : {}),
        decidedBy: user,
      });
      deps.audit?.('memory.rule_decided', {
        actor: user,
        detail: { botId, proposalId: proposal.id, action: body.action, ruleAtomId: proposal.ruleAtomId },
      });
      res.json({ ok: true, proposal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown rule proposal') ? 404 : 400;
      res.status(status).json(errorBody('Failed to decide rule proposal', message));
    }
  });

  return router;
}
