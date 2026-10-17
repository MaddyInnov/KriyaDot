// SPDX-License-Identifier: Apache-2.0
// HTTP routes for AgentTeams.
//
//   POST   /                        → { name, coordinatorBotId, memberBotIds[] }
//   GET    /                        → list teams
//   DELETE /:id                     → delete team (+ runs)
//   POST   /:id/run                 → { task } → starts a coordinator turn (SSE for progress)
//   GET    /:id/runs                → run history
//   GET    /:id/runs/:runId         → run detail
//   GET    /:id/runs/:runId/stream  → SSE: step_start | step_done | done | failed
//   GET    /:id/delegation-policy   → { delegationPolicy, delegationPolicyOverrides }
//   PATCH  /:id/delegation-policy   → { delegationPolicy?, delegationPolicyOverrides? }
//
// Peer-delegation approval (workstream C): when the coordinator's `delegate`
// tool targets another bot, the run's delegate gate consults the team's
// delegation policy ('approve-once-per-team' | 'always-ask' | 'always-allow',
// per-bot overrides supported). Unless the policy says 'always-allow' (or a
// grant already covers the team), the gate mints an approval through the
// approval broker — the user decides in the approvals inbox/cards — and a
// denial aborts the subtask with a clear message.
//
// A run is one coordinator turn: the coordinator breaks the task into steps
// and assigns each step to the best-fit member via the `delegate` tool's
// `bot` parameter. Members get scoped subtasks; the coordinator synthesizes
// the final answer. Delegation flows through normal governance.

import express, { type Request, type Response, type Router } from 'express';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  DEFAULT_DELEGATION_POLICY,
  DELEGATION_POLICIES,
  TEAM_MANIFEST_FORMAT,
  TeamDirectoryStore,
  TeamStore,
  buildCoordinatorPrompt,
  buildTeamManifest,
  describeTeamImport,
  enrichActor,
  isDelegationPolicy,
  resolveDelegationPolicy,
  teamManifestFilename,
  validateTeamManifest,
  withEnrichedRunActors,
  parseTeamMarkdown,
  resolveMarkdownBots,
  serializeTeamMarkdown,
  type AgentRuntime,
  type BotConfig,
  type DelegateGate,
  type DelegationPolicy,
  type StreamEvent,
  type Team,
  type TeamManifest,
  type TeamRun,
  type TeamStep,
} from '@mvp/agent-runtime';

export interface TeamRouteDeps {
  dataDir: string;
  agentRuntime: AgentRuntime;
  getBots: () => BotConfig[];
  /**
   * Approval broker for team peer-delegation (workstream C). When set,
   * bot→bot delegation in coordinator runs is gated on user approval per
   * the team's delegation policy; the broker mints the approval card and
   * the user decides in the approvals inbox. Unset → the peer-approval gate
   * allows delegations (pre-workstream behaviour) with a console warning.
   *
   * HOST WIRING: pass `deps.governanceAdapter` (GovernanceAdapter
   * implements this interface structurally via
   * requestPeerDelegationApproval + awaitDecision).
   */
  delegationBroker?: DelegationApprovalBroker;
  /**
   * Audit sink (optional). Used for manifest export/import events.
   *
   * HOST WIRING: pass `(action, fields) => deps.governance.audit(action, fields)`.
   */
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

/**
 * Minimal approval-broker surface the delegation gate needs: mint a
 * peer-delegation approval card, then wait for the human decision.
 */
export interface DelegationApprovalBroker {
  requestPeerDelegationApproval(args: {
    sessionId: string;
    botId: string;
    fromBotId: string;
    toBotId: string;
    task: string;
    policy: DelegationPolicy;
  }): Promise<string>;
  awaitDecision(approvalId: string, opts?: { timeoutMs?: number }): Promise<'approved' | 'denied'>;
}

/**
 * Build the delegate gate for one team's coordinator runs. The gate runs
 * before governance on every `delegate` tool call:
 * - self-delegation (no `bot` arg, or `bot` === caller) is a plain subagent
 *   spawn, not peer delegation → allow.
 * - 'always-allow' → allow.
 * - 'approve-once-per-team' with an existing grant → allow.
 * - otherwise mint an approval through the broker and await the user's
 *   decision; 'approved' → allow (recording the grant for
 *   approve-once-per-team), anything else → deny with a clear message that
 *   aborts the subtask.
 */
export function createDelegationGate(
  teamId: string,
  opts: { store: TeamStore; broker?: DelegationApprovalBroker },
): DelegateGate {
  return async (call, ctx) => {
    const team = opts.store.getTeam(teamId);
    const targetBotId =
      typeof call.args?.bot === 'string' && call.args.bot ? call.args.bot : ctx.botId;
    if (!team || targetBotId === ctx.botId) return { decision: 'allow' };
    const policy = resolveDelegationPolicy(team, targetBotId);
    if (policy === 'always-allow') return { decision: 'allow' };
    if (policy === 'approve-once-per-team' && opts.store.hasDelegationGrant(teamId)) {
      return { decision: 'allow' };
    }
    if (!opts.broker) {
      console.warn(
        `[teams] delegation approval broker not wired; allowing peer delegation in team "${teamId}" without approval`,
      );
      return { decision: 'allow' };
    }
    const taskText = typeof call.args?.task === 'string' ? call.args.task : '';
    let approvalId: string;
    try {
      approvalId = await opts.broker.requestPeerDelegationApproval({
        sessionId: ctx.sessionId,
        botId: ctx.botId,
        fromBotId: ctx.botId,
        toBotId: targetBotId,
        task: taskText,
        policy,
      });
    } catch (err) {
      return {
        decision: 'deny',
        reason: `could not request delegation approval: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    let verdict: 'approved' | 'denied';
    try {
      verdict = await opts.broker.awaitDecision(approvalId);
    } catch (err) {
      return {
        decision: 'deny',
        reason: `delegation approval failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (verdict !== 'approved') {
      return {
        decision: 'deny',
        reason:
          `the delegation was not approved (team "${team.name}", policy "${policy}"): ` +
          `subtask for member bot "${targetBotId}" was not started. Reassign the step or proceed without it.`,
      };
    }
    if (policy === 'approve-once-per-team') opts.store.recordDelegationGrant(teamId);
    return { decision: 'allow' };
  };
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

/**
 * Markdown team-spec sidecar (<dataDir>/team-markdown-meta.json): data the
 * teams table doesn't hold — the roster prompt, description, and per-member
 * persona/tool notes from a markdown import. Keyed by team id; read back by
 * GET /:id/export-markdown so the round trip is lossless.
 */
interface TeamMarkdownMeta {
  rosterPrompt?: string;
  description?: string;
  members?: Array<{ botId: string; persona?: string; tools?: string[]; note?: string; name?: string }>;
}

function markdownMetaPath(dataDir: string): string {
  return join(dataDir, 'team-markdown-meta.json');
}

function readMarkdownMeta(dataDir: string): Record<string, TeamMarkdownMeta> {
  try {
    const raw = readFileSync(markdownMetaPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, TeamMarkdownMeta>;
    }
  } catch {
    // absent or corrupt → empty
  }
  return {};
}

function writeMarkdownMeta(dataDir: string, meta: Record<string, TeamMarkdownMeta>): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${markdownMetaPath(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  const { renameSync } = require('node:fs') as typeof import('node:fs');
  renameSync(tmp, markdownMetaPath(dataDir));
}

/** Heuristic: does the body look like a raw team manifest (not wrapped)? */
function isManifestLike(body: Record<string, unknown>): boolean {
  return body.format === TEAM_MANIFEST_FORMAT && typeof body.team === 'object' && body.team !== null;
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

type TeamEvent =
  | { kind: 'step_start'; index: number; step: TeamStep }
  | { kind: 'step_done'; index: number; step: TeamStep }
  | { kind: 'done'; result: string }
  | { kind: 'failed'; error: string };

function summarizeResult(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  return text.slice(0, 400);
}

export interface TeamRoutesHandle {
  store: TeamStore;
  /**
   * Retry a team run: starts a fresh run with the same task and executes
   * it. Used by the crash-recovery resume path. Returns the new run, or
   * undefined when the team/run is unknown or still running.
   */
  retryRun: (teamId: string, runId: string) => TeamRun | undefined;
}

export function registerTeamRoutes(router: Router, deps: TeamRouteDeps): TeamRoutesHandle {
  const store = new TeamStore(join(deps.dataDir));
  const dirStore = new TeamDirectoryStore(join(deps.dataDir));
  // runId → subscriber set for live SSE progress
  const subscribers = new Map<string, Set<(evt: TeamEvent) => void>>();

  // Every step returned over the API carries an enriched `actor` field:
  // matched against the team directory ({role, team, relationship}), and
  // passed through unchanged when unmatched.
  const enrichRun = (run: TeamRun) => withEnrichedRunActors(run, dirStore);

  const publish = (runId: string, evt: TeamEvent): void => {
    const set = subscribers.get(runId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(evt);
      } catch {
        // subscriber gone; SSE close handler removes it
      }
    }
  };

  router.post('/', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      name?: unknown;
      coordinatorBotId?: unknown;
      memberBotIds?: unknown;
      delegationPolicy?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name : '';
    const coordinatorBotId = typeof body.coordinatorBotId === 'string' ? body.coordinatorBotId : '';
    const memberBotIds = Array.isArray(body.memberBotIds)
      ? (body.memberBotIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const delegationPolicy =
      body.delegationPolicy === undefined ? undefined : body.delegationPolicy;
    if (delegationPolicy !== undefined && !isDelegationPolicy(delegationPolicy)) {
      res
        .status(400)
        .json(errorBody(`delegationPolicy must be one of: ${DELEGATION_POLICIES.join(', ')}`));
      return;
    }
    const bots = new Map(deps.getBots().map((b) => [b.id, b]));
    if (!coordinatorBotId || !bots.has(coordinatorBotId)) {
      res.status(400).json(errorBody('coordinatorBotId must be a known bot id'));
      return;
    }
    const members = [...new Set(memberBotIds)];
    if (members.length === 0) {
      res.status(400).json(errorBody('memberBotIds must list at least one bot'));
      return;
    }
    for (const m of members) {
      if (!bots.has(m)) {
        res.status(400).json(errorBody(`unknown member bot "${m}"`));
        return;
      }
      if (m === coordinatorBotId) {
        res.status(400).json(errorBody('coordinator cannot also be a member'));
        return;
      }
    }
    const team = store.createTeam(name, coordinatorBotId, members);
    if (delegationPolicy) store.setDelegationPolicy(team.id, delegationPolicy);
    res.json({ ok: true, team: store.getTeam(team.id) ?? team });
  });

  router.get('/', (_req: Request, res: Response) => {
    res.json({ ok: true, teams: store.listTeams() });
  });

  // -- Delegation policy (workstream C) -----------------------------------
  //   GET    /:id/delegation-policy   → { ok, teamId, delegationPolicy,
  //                                       delegationPolicyOverrides }
  //   PATCH  /:id/delegation-policy   → { delegationPolicy?,
  //                                       delegationPolicyOverrides? }
  //                                     → { ok, team }
  //
  // Controls how bot→bot delegation in coordinator runs is gated on user
  // approval: 'approve-once-per-team' (default), 'always-ask',
  // 'always-allow'. Overrides map a member bot id to its own policy.
  // Changing the policy revokes any existing approve-once grant.

  router.get('/:id/delegation-policy', (req: Request, res: Response) => {
    const team = store.getTeam(req.params.id);
    if (!team) {
      res.status(404).json(errorBody(`Unknown team "${req.params.id}"`));
      return;
    }
    res.json({
      ok: true,
      teamId: team.id,
      delegationPolicy: team.delegationPolicy ?? DEFAULT_DELEGATION_POLICY,
      delegationPolicyOverrides: team.delegationPolicyOverrides ?? {},
    });
  });

  router.patch('/:id/delegation-policy', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid team id'));
      return;
    }
    const team = store.getTeam(id);
    if (!team) {
      res.status(404).json(errorBody(`Unknown team "${id}"`));
      return;
    }
    const body = (req.body ?? {}) as {
      delegationPolicy?: unknown;
      delegationPolicyOverrides?: unknown;
    };
    const policy =
      body.delegationPolicy === undefined
        ? (team.delegationPolicy ?? DEFAULT_DELEGATION_POLICY)
        : body.delegationPolicy;
    if (!isDelegationPolicy(policy)) {
      res
        .status(400)
        .json(errorBody(`delegationPolicy must be one of: ${DELEGATION_POLICIES.join(', ')}`));
      return;
    }
    let overrides: Record<string, DelegationPolicy> | undefined;
    if (body.delegationPolicyOverrides !== undefined) {
      const raw = body.delegationPolicyOverrides;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        res.status(400).json(errorBody('delegationPolicyOverrides must be an object of botId → policy'));
        return;
      }
      overrides = {};
      for (const [botId, p] of Object.entries(raw as Record<string, unknown>)) {
        if (!team.memberBotIds.includes(botId)) {
          res.status(400).json(errorBody(`override bot "${botId}" is not a member of this team`));
          return;
        }
        if (!isDelegationPolicy(p)) {
          res
            .status(400)
            .json(errorBody(`override for "${botId}" must be one of: ${DELEGATION_POLICIES.join(', ')}`));
          return;
        }
        overrides[botId] = p;
      }
    }
    const updated = store.setDelegationPolicy(id, policy, overrides ?? team.delegationPolicyOverrides);
    if (body.delegationPolicy !== undefined) {
      // A policy change invalidates any approve-once grant.
      store.revokeDelegationGrant(id);
    }
    res.json({ ok: true, team: updated });
  });

  // -- Team directory (actor enrichment) ---------------------------------
  // Registered before the `/:id` routes so `/directory` is never mistaken
  // for a team id.
  //
  //   GET    /directory              → { ok, members }
  //   POST   /directory              → { name, handle?, email?, role?,
  //                                     team?, timezone?, notes?,
  //                                     relationship? } → { ok, member }
  //   PATCH  /directory/:memberId    → { ok, member }
  //   DELETE /directory/:memberId    → { ok, deleted }

  router.get('/directory', (_req: Request, res: Response) => {
    res.json({ ok: true, members: dirStore.listMembers() });
  });

  router.post('/directory', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const member = dirStore.addMember({
        name: typeof body.name === 'string' ? body.name : '',
        handle: typeof body.handle === 'string' ? body.handle : undefined,
        email: typeof body.email === 'string' ? body.email : undefined,
        role: typeof body.role === 'string' ? body.role : undefined,
        team: typeof body.team === 'string' ? body.team : undefined,
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
        relationship: typeof body.relationship === 'string' ? body.relationship : undefined,
      });
      res.status(201).json({ ok: true, member });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to add directory member'));
    }
  });

  router.patch('/directory/:memberId', (req: Request, res: Response) => {
    const memberId = req.params.memberId;
    if (!validId(memberId)) {
      res.status(400).json(errorBody('Invalid member id'));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, string> = {};
    for (const key of ['name', 'handle', 'email', 'role', 'team', 'timezone', 'notes', 'relationship'] as const) {
      if (typeof body[key] === 'string') patch[key] = body[key] as string;
    }
    try {
      const member = dirStore.updateMember(memberId, patch);
      if (!member) {
        res.status(404).json(errorBody(`Unknown directory member "${memberId}"`));
        return;
      }
      res.json({ ok: true, member });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to update directory member'));
    }
  });

  router.delete('/directory/:memberId', (req: Request, res: Response) => {
    const memberId = req.params.memberId;
    if (!validId(memberId)) {
      res.status(400).json(errorBody('Invalid member id'));
      return;
    }
    if (!dirStore.deleteMember(memberId)) {
      res.status(404).json(errorBody(`Unknown directory member "${memberId}"`));
      return;
    }
    res.json({ ok: true, deleted: memberId });
  });

  // -- Team-sharing manifest (OpenMausBot parity P1 #18) -------------------
  //   POST /export { teamId } → downloadable `kriyadot.team.json` manifest:
  //                             team identity, embedded full bot configs,
  //                             roster-prompt snapshot, coordination rules,
  //                             referenced workflows, SHA-256 checksum.
  //   POST /import { manifest, confirm?, importBots? } → validates schema +
  //                             checksum, dedupes by team name (409 on
  //                             collision unless confirm: true), imports any
  //                             embedded bots that don't exist yet, and
  //                             creates the team with a fresh id.
  //
  // The manifest is a plain readable JSON spec: users can hand-edit,
  // version-control, or share it. Import NEVER overwrites existing teams
  // or bots — collisions are reported, not merged.

  const appVersion = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const pkg = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { version?: string };
      return `kriyadot-api/${pkg.version ?? '0.1.0'}`;
    } catch {
      return 'kriyadot-api/0.1.0';
    }
  })();

  router.post('/export', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { teamId?: unknown };
    const teamId = typeof body.teamId === 'string' ? body.teamId : '';
    if (!teamId || !validId(teamId)) {
      res.status(400).json(errorBody('"teamId" is required'));
      return;
    }
    const team = store.getTeam(teamId);
    if (!team) {
      res.status(404).json(errorBody(`Unknown team "${teamId}"`));
      return;
    }
    const bots = new Map(deps.getBots().map((b) => [b.id, b]));
    const coordinator = bots.get(team.coordinatorBotId);
    if (!coordinator) {
      res
        .status(410)
        .json(errorBody(`Coordinator bot "${team.coordinatorBotId}" no longer exists — cannot export a portable manifest`));
      return;
    }
    const members: BotConfig[] = [];
    for (const id of team.memberBotIds) {
      const b = bots.get(id);
      if (!b) {
        res
          .status(410)
          .json(errorBody(`Member bot "${id}" no longer exists — cannot export a portable manifest`));
        return;
      }
      members.push(b);
    }
    const manifest = buildTeamManifest({
      team,
      coordinator,
      members,
      appVersion,
    });
    deps.audit?.('teams.manifest_export', {
      actor: 'api',
      detail: { teamId: team.id, name: team.name, members: members.length },
    });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${teamManifestFilename(team.name, manifest.exportedAt)}"`,
    );
    res.json(manifest);
  });

  router.post('/import', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      manifest?: unknown;
      confirm?: unknown;
      importBots?: unknown;
    };
    // Accept { manifest } or the raw manifest object as the body.
    const raw = body.manifest ?? (isManifestLike(body) ? body : undefined);
    if (raw === undefined) {
      res.status(400).json(errorBody('body.manifest (a team manifest object) is required'));
      return;
    }
    const validation = validateTeamManifest(raw);
    if (!validation.ok) {
      res.status(400).json(errorBody('Invalid team manifest', validation.errors.join('; ')));
      return;
    }
    const manifest = validation.manifest;
    const bots = deps.getBots();
    const botIds = new Set(bots.map((b) => b.id));
    const plan = describeTeamImport(
      manifest,
      store.listTeams().map((t) => ({ id: t.id, name: t.name })),
      botIds,
    );
    if (plan.nameCollision && body.confirm !== true) {
      res.status(409).json({
        ok: false,
        error: `A team named "${plan.nameCollision.name}" already exists — import never overwrites. Re-send with { confirm: true } to create it anyway.`,
        conflict: plan.nameCollision,
        missingBotIds: plan.missingBotIds,
      });
      return;
    }

    // Import embedded bots that don't exist yet (self-contained manifest).
    const importBots = body.importBots !== false;
    const importedBots: string[] = [];
    if (importBots && plan.missingBotIds.length > 0) {
      const { appendRosterImport } = await import('./bot-roster-routes.js');
      const { allocateBotWorkspace } = await import('./bot-workspace-alloc.js');
      const embedded = new Map(
        [manifest.team.coordinator, ...manifest.team.members].map((b) => [b.id, b]),
      );
      for (const id of plan.missingBotIds) {
        const cfg = embedded.get(id);
        if (!cfg) continue;
        try {
          allocateBotWorkspace(cfg, deps.dataDir);
        } catch {
          // Invalid bot id — workspace allocation is best-effort on import.
        }
        bots.push(cfg);
        botIds.add(id);
        appendRosterImport(cfg, deps.dataDir);
        importedBots.push(id);
      }
    } else if (!importBots && plan.missingBotIds.length > 0) {
      res.status(400).json(
        errorBody(
          `Manifest references unknown bots (${plan.missingBotIds.join(', ')}) and importBots is false`,
        ),
      );
      return;
    }

    const team = store.createTeam(
      manifest.team.name,
      manifest.team.coordinator.id,
      manifest.team.members.map((m) => m.id),
    );
    store.setDelegationPolicy(
      team.id,
      manifest.team.coordinationRules.delegationPolicy,
      manifest.team.coordinationRules.delegationPolicyOverrides,
    );
    deps.audit?.('teams.manifest_import', {
      actor: 'api',
      detail: {
        teamId: team.id,
        name: team.name,
        confirmed: plan.nameCollision !== null,
        importedBots,
        workflows: manifest.team.workflows,
      },
    });
    res.status(201).json({
      ok: true,
      team,
      importedBots,
      workflows: manifest.team.workflows,
      note: 'Coordination rules restored from the manifest. Run history is not part of the manifest.',
    });
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid team id'));
      return;
    }
    if (!store.deleteTeam(id)) {
      res.status(404).json(errorBody(`Unknown team "${id}"`));
      return;
    }
    // Drop the markdown sidecar entry with the team.
    const meta = readMarkdownMeta(deps.dataDir);
    if (meta[id]) {
      delete meta[id];
      writeMarkdownMeta(deps.dataDir, meta);
    }
    res.json({ ok: true, deleted: id });
  });

  // -- Markdown team import/export (BotMRR parity) ---------------------------
  //   POST /import-markdown { markdown } → parses the markdown team-spec
  //     (see packages/agent-runtime/src/team-markdown.ts for the format),
  //     validates, resolves member bot references, and creates the team via
  //     the same TeamStore as the JSON API. Roster prompt / description /
  //     member personas persist in the markdown sidecar.
  //   GET /:id/export-markdown → { ok, teamId, markdown } round-trips the
  //     team back to the spec format (add ?download=1 for a .md attachment).

  router.post('/import-markdown', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { markdown?: unknown };
    if (typeof body.markdown !== 'string' || !body.markdown.trim()) {
      res.status(400).json(errorBody('"markdown" (a team-spec document) is required'));
      return;
    }
    if (body.markdown.length > 100_000) {
      res.status(400).json(errorBody('markdown document is too large (max 100KB)'));
      return;
    }
    const parsed = parseTeamMarkdown(body.markdown);
    if (!parsed.ok || !parsed.spec) {
      res.status(400).json({
        ok: false,
        error: 'Could not parse the team document',
        issues: parsed.issues,
      });
      return;
    }
    const spec = parsed.spec;
    let resolved: Array<{ name: string; role: string; botId: string; persona?: string; tools?: string[]; note?: string }>;
    try {
      resolved = resolveMarkdownBots(spec, deps.getBots());
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Unknown bots'));
      return;
    }
    const coordinator = resolved.find((m) => m.role === 'coordinator') ?? resolved[0]!;
    const members = resolved.filter((m) => m.botId !== coordinator.botId).map((m) => m.botId);
    if (members.length === 0) {
      res.status(400).json(errorBody('The team needs at least one member besides the coordinator'));
      return;
    }
    const team = store.createTeam(spec.name, coordinator.botId, members);
    const policy = spec.coordinationRules.delegationPolicy;
    if (policy || spec.coordinationRules.overrides) {
      store.setDelegationPolicy(
        team.id,
        (policy ?? DEFAULT_DELEGATION_POLICY) as DelegationPolicy,
        spec.coordinationRules.overrides as Record<string, DelegationPolicy> | undefined,
      );
    }
    const meta = readMarkdownMeta(deps.dataDir);
    meta[team.id] = {
      ...(spec.rosterPrompt ? { rosterPrompt: spec.rosterPrompt } : {}),
      ...(spec.description ? { description: spec.description } : {}),
      members: resolved.map((m) => ({
        botId: m.botId,
        name: m.name,
        ...(m.persona ? { persona: m.persona } : {}),
        ...(m.tools ? { tools: m.tools } : {}),
        ...(m.note ? { note: m.note } : {}),
      })),
    };
    writeMarkdownMeta(deps.dataDir, meta);
    deps.audit?.('teams.markdown_import', {
      actor: 'api',
      detail: { teamId: team.id, name: team.name, members: members.length + 1 },
    });
    res.status(201).json({
      ok: true,
      team: store.getTeam(team.id) ?? team,
      issues: parsed.issues,
      note: 'Team created from the markdown spec. Roster prompt and member notes are kept for export round-trip.',
    });
  });

  router.get('/:id/export-markdown', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid team id'));
      return;
    }
    const team = store.getTeam(id);
    if (!team) {
      res.status(404).json(errorBody(`Unknown team "${id}"`));
      return;
    }
    const bots = deps.getBots();
    const meta = readMarkdownMeta(deps.dataDir)[id];
    const metaMembers = new Map((meta?.members ?? []).map((m) => [m.botId, m]));
    const markdown = serializeTeamMarkdown(
      {
        name: team.name,
        description: meta?.description,
        coordinatorBotId: team.coordinatorBotId,
        memberBotIds: team.memberBotIds,
        delegationPolicy: team.delegationPolicy ?? DEFAULT_DELEGATION_POLICY,
        delegationPolicyOverrides: team.delegationPolicyOverrides,
        rosterPrompt: meta?.rosterPrompt,
      },
      bots.map((b) => {
        const mm = metaMembers.get(b.id);
        return {
          id: b.id,
          name: mm?.name ?? b.name,
          ...(mm?.persona ? { persona: mm.persona } : {}),
        };
      }),
    );
    if (req.query.download === '1') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${team.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.team.md"`);
      res.send(markdown);
      return;
    }
    res.json({ ok: true, teamId: id, markdown });
  });

  /** Fire-and-forget coordinator turn for a team run. */
  const executeRun = (team: Team, runId: string): void => {
    const bots = new Map(deps.getBots().map((b) => [b.id, b]));
    const coordinator = bots.get(team.coordinatorBotId);
    if (!coordinator) {
      store.updateRun(runId, { status: 'failed', error: `coordinator bot "${team.coordinatorBotId}" no longer exists` });
      publish(runId, { kind: 'failed', error: 'coordinator bot missing' });
      return;
    }
    const run = store.getRun(runId);
    if (!run) return;
    const members = team.memberBotIds
      .map((id) => bots.get(id))
      .filter((b): b is BotConfig => Boolean(b));
    const customRoster = readMarkdownMeta(deps.dataDir)[team.id]?.rosterPrompt;
    const prompt = buildCoordinatorPrompt({
      teamName: team.name,
      coordinatorName: coordinator.name,
      members: members.map((m) => ({ id: m.id, name: m.name, description: m.description })),
      task: run.task,
    });
    // A markdown-imported custom roster prompt is prepended verbatim.
    const fullPrompt = customRoster ? `${customRoster}\n\n${prompt}` : prompt;

    let resultText = '';
    let steps: TeamStep[] = [];
    const stepByCallId = new Map<string, number>();

    void (async () => {
      try {
        await deps.agentRuntime.runTurn({
          bot: coordinator,
          message: fullPrompt,
          sessionId: `team_${team.id}_${runId}`,
          taskType: 'chat',
          // Peer-delegation approval (workstream C): bot→bot delegation is
          // gated on user approval per the team's delegation policy.
          delegateGate: createDelegationGate(team.id, { store, broker: deps.delegationBroker }),
          onEvent: async (e: StreamEvent) => {
            if (e.type === 'token') {
              resultText += e.content;
            } else if (e.type === 'tool_call' && e.call.name === 'delegate') {
              const botId = typeof e.call.args?.bot === 'string' && e.call.args.bot ? e.call.args.bot : coordinator.id;
              const taskArg = typeof e.call.args?.task === 'string' ? e.call.args.task : '';
              const member = bots.get(botId);
              const step: TeamStep = {
                memberBotId: botId,
                memberName: member?.name ?? botId,
                task: taskArg.slice(0, 500),
                done: false,
              };
              steps = [...steps, step];
              stepByCallId.set(e.call.id, steps.length - 1);
              store.updateRun(runId, { steps });
              publish(runId, { kind: 'step_start', index: steps.length - 1, step });
            } else if (e.type === 'tool_result' && e.call.name === 'delegate') {
              const idx = stepByCallId.get(e.call.id);
              if (idx !== undefined && steps[idx]) {
                steps = steps.map((s, i) =>
                  i === idx ? { ...s, done: true, summary: summarizeResult(e.result) } : s,
                );
                store.updateRun(runId, { steps });
                publish(runId, { kind: 'step_done', index: idx, step: steps[idx] });
              }
            } else if (e.type === 'error') {
              store.updateRun(runId, { status: 'failed', steps, error: e.message });
              publish(runId, { kind: 'failed', error: e.message });
            } else if (e.type === 'interrupted') {
              store.updateRun(runId, { status: 'failed', steps, error: `interrupted: ${e.reason}` });
              publish(runId, { kind: 'failed', error: `interrupted: ${e.reason}` });
            }
          },
        });
        const final = store.getRun(runId);
        if (final && final.status === 'running') {
          store.updateRun(runId, { status: 'done', steps, result: resultText.trim() });
          publish(runId, { kind: 'done', result: resultText.trim() });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.updateRun(runId, { status: 'failed', steps, error: message });
        publish(runId, { kind: 'failed', error: message });
      } finally {
        subscribers.delete(runId);
      }
    })();
  };

  router.post('/:id/run', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid team id'));
      return;
    }
    const team = store.getTeam(id);
    if (!team) {
      res.status(404).json(errorBody(`Unknown team "${id}"`));
      return;
    }
    const body = (req.body ?? {}) as { task?: unknown };
    const task = typeof body.task === 'string' ? body.task.trim().slice(0, 8000) : '';
    if (!task) {
      res.status(400).json(errorBody('"task" is required'));
      return;
    }
    const run = store.startRun(id, task);
    executeRun(team, run.id);
    res.json({ ok: true, run: enrichRun(run) });
  });

  router.get('/:id/runs', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid team id'));
      return;
    }
    if (!store.getTeam(id)) {
      res.status(404).json(errorBody(`Unknown team "${id}"`));
      return;
    }
    res.json({ ok: true, runs: store.listRuns(id).map(enrichRun) });
  });

  router.get('/:id/runs/:runId', (req: Request, res: Response) => {
    const run = store.getRun(req.params.runId);
    if (!run || run.teamId !== req.params.id) {
      res.status(404).json(errorBody('Unknown run'));
      return;
    }
    res.json({ ok: true, run: enrichRun(run) });
  });

  /**
   * Retry an interrupted/failed team run: starts a FRESH run with the same
   * task (crash-recovery resume path). The original run record is kept.
   */
  router.post('/:id/runs/:runId/retry', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid team id'));
      return;
    }
    const team = store.getTeam(id);
    if (!team) {
      res.status(404).json(errorBody(`Unknown team "${id}"`));
      return;
    }
    const run = store.getRun(req.params.runId);
    if (!run || run.teamId !== id) {
      res.status(404).json(errorBody('Unknown run'));
      return;
    }
    if (run.status === 'running') {
      res.status(409).json(errorBody('Run is still in progress'));
      return;
    }
    const fresh = retryRun(id, run.id);
    if (!fresh) {
      res.status(404).json(errorBody('Unknown run'));
      return;
    }
    res.status(202).json({ ok: true, run: enrichRun(fresh), retriedFrom: run.id });
  });

  router.get('/:id/runs/:runId/stream', (req: Request, res: Response) => {
    const run = store.getRun(req.params.runId);
    if (!run || run.teamId !== req.params.id) {
      res.status(404).json(errorBody('Unknown run'));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    // Replay current state so late joiners see progress so far.
    const current = store.getRun(run.id);
    if (current) {
      enrichRun(current).steps.forEach((step, index) => {
        res.write(`data: ${JSON.stringify({ kind: step.done ? 'step_done' : 'step_start', index, step })}\n\n`);
      });
      if (current.status === 'done') {
        res.write(`data: ${JSON.stringify({ kind: 'done', result: current.result ?? '' })}\n\n`);
        res.end();
        return;
      }
      if (current.status === 'failed') {
        res.write(`data: ${JSON.stringify({ kind: 'failed', error: current.error ?? 'failed' })}\n\n`);
        res.end();
        return;
      }
    }
    let set = subscribers.get(run.id);
    if (!set) {
      set = new Set();
      subscribers.set(run.id, set);
    }
    const send = (evt: TeamEvent): void => {
      try {
        // Enrich step actors against the team directory for live events too.
        const out =
          evt.kind === 'step_start' || evt.kind === 'step_done'
            ? { ...evt, step: { ...evt.step, actor: enrichActor(evt.step.memberName, dirStore) } }
            : evt;
        res.write(`data: ${JSON.stringify(out)}\n\n`);
        if (evt.kind === 'done' || evt.kind === 'failed') {
          res.end();
        }
      } catch {
        // client gone; close handler removes the subscriber
      }
    };
    set.add(send);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // ignore
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      const s = subscribers.get(run.id);
      if (s) s.delete(send);
    });
  });

  const retryRun = (teamId: string, runId: string): TeamRun | undefined => {
    const team = store.getTeam(teamId);
    const run = store.getRun(runId);
    if (!team || !run || run.teamId !== teamId || run.status === 'running') return undefined;
    const fresh = store.startRun(teamId, run.task);
    executeRun(team, fresh.id);
    deps.audit?.('teams.run_retry', {
      actor: 'api',
      detail: { teamId, fromRunId: run.id, newRunId: fresh.id },
    });
    return store.getRun(fresh.id) ?? fresh;
  };

  return { store, retryRun };
}
