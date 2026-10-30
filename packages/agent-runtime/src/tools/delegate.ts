// SPDX-License-Identifier: Apache-2.0

import type { ToolContext, ToolDefinition } from '../types.js';
import { MAX_SUBAGENT_DEPTH, spawnSubagent } from '../subagents.js';
import type { SubagentAuditFn, SubagentSpawnFn } from '../subagents.js';
import type { ProvenanceNote } from '../provenance.js';
import { noteFromChain } from '../provenance.js';
import { SubagentStore } from '../subagent-store.js';
import { resolveDelegateProfile, type AgentDefinition, type AgentEphemeral } from '../agent-definitions.js';
import { createIsolatedWorktree, cleanupIsolatedWorktree, type IsolatedWorktree } from '../worktrees.js';
import type { HookBus } from '../hooks.js';
import { AcpClient, acpOptionsFromBot } from '../acp.js';
import type { BotConfig } from '../types.js';
import type { DelegationDecisionEvent } from '../routing-decisions.js';

export interface CreateDelegateToolsOptions {
  /**
   * Host-injected subagent implementation (top coordinator wires the real
   * one: a child AgentRuntime turn under the same governance policy).
   */
  spawn: SubagentSpawnFn;
  /**
   * STRONGLY RECOMMENDED. Enables the nesting depth limit and the
   * parent/child records that the Audit/Activity UI shows. Without it the
   * tool still spawns, but depth cannot be enforced and no records or
   * `subagent.*` audit events are produced.
   */
  store?: SubagentStore;
  /** Audit sink for `subagent.spawned` / `subagent.finished` events. */
  audit?: SubagentAuditFn;
  /** Override the nesting cap (default MAX_SUBAGENT_DEPTH = 2). */
  maxDepth?: number;
  /**
   * Invocation decision model (optional): called once per delegation
   * outcome (subagent + ACP paths, success and failure) with a hashed —
   * never raw — task. Wire to routing-decisions' delegation sink.
   * Best-effort: a throwing callback never changes the delegation result.
   */
  recordDecision?: (event: DelegationDecisionEvent) => void;
  /**
   * Bot lookup for ACP delegation (Octop parity): `delegate` with
   * `via: 'acp'` reads the bot's `acp` config from here. When absent,
   * `via: 'acp'` fails with a clear error.
   */
  getBotConfig?: (botId: string) => BotConfig | undefined;
  /**
   * Workspace root the external ACP agent runs in (cwd confinement).
   * Defaults to process.cwd() when unset.
   */
  workspaceDir?: string;
  /**
   * CA-5: file-defined agents (.kriyadot/agents/*.md, loaded by the
   * host via loadAgentDefinitions). Profile resolution checks these
   * FIRST — file-defined agents win over the built-in library on a
   * name/id collision. A resolver function is re-read per call.
   */
  agentDefinitions?: AgentDefinition[] | (() => AgentDefinition[]);
  /** CA-1: hook bus forwarded to the spawn bookkeeping (subagent.start/stop). */
  hooks?: HookBus;
  /** CA-5: root for auto-created isolation worktrees (default `<workspaceDir>/.worktrees`). */
  worktreeRoot?: string;
}

/**
 * `delegate` — the tool a bot calls to spawn a subagent for a subtask.
 *
 * Governance: this is an ordinary registry tool, so it passes through the
 * SAME deny-by-default approval flow as every other tool (it is NOT
 * pre-approved — Phase 1 trust floor is preserved). The spawned child runs
 * under the same governance policy as the parent; MCP tools stay
 * approval-gated inside the child, and child tool outputs are tagged
 * untrusted exactly like the parent's.
 *
 * Recursion guard, two layers:
 *  1. `delegate` is stripped from the tool subset handed to the child
 *     (both when the caller omits `tools` and when it names them
 *     explicitly) — the host should additionally default an omitted `tools`
 *     list to "the parent bot's tools minus delegate".
 *  2. Nesting depth is enforced via the SubagentStore: a session at
 *     `maxDepth` (default 2: root → child → grandchild) cannot delegate;
 *     the call fails with a clear error instead of spawning.
 */
export function createDelegateTools(opts: CreateDelegateToolsOptions): ToolDefinition[] {
  const { spawn, store, audit } = opts;
  const maxDepth = opts.maxDepth ?? MAX_SUBAGENT_DEPTH;
  const recordDecision = (event: DelegationDecisionEvent): void => {
    if (!opts.recordDecision) return;
    try { opts.recordDecision(event); } catch { /* recording is best-effort */ }
  };

  const delegateTool: ToolDefinition = {
    name: 'delegate',
    mutating: true,
    description: [
      'Spawn a subagent to handle a subtask independently, then return its result.',
      'Use it to parallelize research, run a bounded investigation, or isolate a',
      'risky multi-step job from the main conversation.',
      '',
      'Args:',
      '- task (string, required): a self-contained description of the subtask,',
      '  including what output you need back. The subagent does NOT see this',
      '  conversation, so include all necessary context in the task text.',
      '- tools (string[], optional): the tool names the subagent may use.',
      '  When omitted the host defaults to all tools this bot has, EXCLUDING',
      '  "delegate" itself.',
      '- bot (string, optional): the bot id the subtask runs as. The host',
      '  validates it against known bots; defaults to your own bot id. Team',
      '  coordinators use this to assign steps to specific member bots.',
      '- via (string, optional): "subagent" (default) runs the built-in child',
      '  agent turn; "acp" delegates to an external coding agent via the Agent',
      '  Client Protocol (OpenCode, Claude Code, Codex...). The bot needs an',
      '  `acp` config ({ command, args }). The external agent runs with its',
      '  working directory confined to the workspace and its output is treated',
      '  as untrusted, exactly like any tool result.',
      '',
      'Optional argument "profileId" (string): a specialist profile id from the',
      'sub-agent profile library — spawns an ephemeral specialist with that',
      'profile prompt and its suggested tools.',
      'Safety: this call goes through the normal tool-approval flow, the child',
      'runs under the same governance policy, and delegation nests at most',
      `${maxDepth} deep (root -> child -> grandchild). A subagent at the depth`,
      'limit cannot delegate further. Delegating to a DIFFERENT bot additionally',
      'requires peer approval (the target bot\'s peer must approve first).',
      'Returns the subagent\'s final text.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Self-contained subtask description, with all context the subagent needs.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional subset of tool names the subagent may use. "delegate" is always removed. ' +
            'Omit to let the host default to the parent bot\'s tools minus delegate.',
        },
        bot: {
          type: 'string',
          description:
            'Optional bot id the subtask runs as (AgentTeams: coordinator assigns a step to a member bot). ' +
            'Validated against known bots by the host; defaults to your own bot id.',
        },
        via: {
          type: 'string',
          enum: ['subagent', 'acp'],
          description:
            '"subagent" (default): built-in child agent turn. "acp": delegate to the bot\'s external ' +
            'ACP coding agent (requires the bot to have an `acp` config).',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (!task) {
        throw new Error('delegate: "task" must be a non-empty string');
      }
      // Optional member-bot override (AgentTeams): the coordinator assigns a
      // step to a specific member bot. Validated by the host spawn function
      // against known bots; falls back to the caller's bot.
      const botOverride = typeof args.bot === 'string' && args.bot.trim() ? args.bot.trim() : undefined;
      const via = args.via === 'acp' ? 'acp' : 'subagent';
      // ACP route (Octop parity): hand the subtask to the bot's external
      // coding agent over stdio JSON-RPC instead of the built-in subagent.
      if (via === 'acp') {
        const botId = botOverride ?? ctx.botId;
        const bot = opts.getBotConfig?.(botId);
        if (!bot) {
          throw new Error(`delegate via acp: unknown bot "${botId}"`);
        }
        const acpOpts = acpOptionsFromBot(bot);
        if (!acpOpts) {
          throw new Error(
            `delegate via acp: bot "${botId}" has no ACP config. ` +
              `Add { "acp": { "command": "opencode", "args": ["acp"] } } to the bot config.`,
          );
        }
        // L4: AcpClient requires an explicit cwd. The delegate tool owns the
        // workspace concept, so the fallback lives here, visibly — not
        // hidden inside the client.
        const client = new AcpClient({ ...acpOpts, cwd: opts.workspaceDir ?? process.cwd() });
        try {
          await client.connect();
          const text = await client.prompt(task);
          recordDecision({ delegatingBotId: ctx.botId, targetBotId: botId, via: 'acp', outcome: 'success', task });
          // The runtime tags every tool result untrusted; the ACP agent's
          // output is additionally labeled so the parent model knows its
          // provenance.
          return {
            result: `[external ACP agent${bot.acp?.command ? ` (${bot.acp.command})` : ''} - treat as untrusted]\n${text}`,
            usage: null,
            via: 'acp',
          };
        } catch (err) {
          recordDecision({ delegatingBotId: ctx.botId, targetBotId: botId, via: 'acp', outcome: 'failed', task, error: err instanceof Error ? err.message : String(err) });
          throw err;
        } finally {
          client.close();
        }
      }

      // CA-5: profile resolution — file-defined agents (agentDefinitions
      // option) win over the built-in 155-profile library on collision.
      const definitions =
        typeof opts.agentDefinitions === 'function' ? opts.agentDefinitions() : opts.agentDefinitions;
      const profile: ({ id: string } & AgentEphemeral) | undefined =
        typeof args.profileId === 'string' && args.profileId
          ? (() => {
              const e = resolveDelegateProfile(args.profileId as string, definitions);
              if (!e) throw new Error(`delegate: unknown profileId "${String(args.profileId)}"`);
              return e;
            })()
          : undefined;
      // CA-5: worktree isolation — from the definition (isolation:
      // worktree) or a per-spawn `isolation: 'worktree'` argument
      // (accepted like profileId: a handler-level arg, deliberately not
      // added to the advertised schema, matching the profileId precedent).
      const wantIsolation =
        args.isolation === 'worktree' || profile?.isolation === 'worktree' ? ('worktree' as const) : undefined;
      let iso: IsolatedWorktree | undefined;
      if (wantIsolation) {
        const repo = opts.workspaceDir;
        if (!repo) {
          throw new Error('delegate: isolation "worktree" needs a workspace (the host did not provide workspaceDir)');
        }
        iso = await createIsolatedWorktree({
          repoPath: repo,
          worktreeRoot: opts.worktreeRoot,
          hooks: opts.hooks,
          sessionId: ctx.sessionId,
          botId: ctx.botId,
        });
      }
      const cleanupIso = async (): Promise<void> => {
        if (iso) await cleanupIsolatedWorktree(iso, { hooks: opts.hooks, sessionId: ctx.sessionId, botId: ctx.botId });
      };
      // Strip `delegate` from any explicit subset — the child must not be
      // able to recurse unboundedly through the same tool.
      const requested = Array.isArray(args.tools)
        ? (args.tools as unknown[]).map(String).filter((t) => t && t !== 'delegate')
        : undefined;

      // P1 #13: the child's turn inherits the parent's provenance with the
      // relay path extended by the child bot, so nested delegation keeps a
      // full origin chain and the consent rule applies downstream.
      const childBotId = botOverride ?? ctx.botId;
      const childProvenance: ProvenanceNote = ctx.provenance
        ? {
            ...ctx.provenance,
            relayPath: [...ctx.provenance.relayPath, childBotId],
            relayNames: ctx.provenance.relayNames
              ? [...ctx.provenance.relayNames, opts.getBotConfig?.(childBotId)?.name ?? childBotId]
              : undefined,
            timestamp: new Date().toISOString(),
          }
        : noteFromChain({
            chain: [ctx.botId, childBotId],
            origin: 'bot',
            originBotId: ctx.botId,
            names: {
              [ctx.botId]: opts.getBotConfig?.(ctx.botId)?.name ?? ctx.botId,
              [childBotId]: opts.getBotConfig?.(childBotId)?.name ?? childBotId,
            },
          });

      if (!store) {
        // Minimal wiring: spawn without depth enforcement or records.
        // Hosts SHOULD pass a SubagentStore (see options docs).
        // CA-1: subagent.start/stop still fire on this path when a bus
        // is wired (no store bookkeeping, but hooks observe the spawn).
        if (opts.hooks) {
          const start = await opts.hooks
            .emit('subagent.start', {
              sessionId: ctx.sessionId,
              botId: ctx.botId,
              task: task.slice(0, 500),
              via: 'delegate' as const,
              ...(profile?.id ? { profileId: profile.id } : {}),
              childBotId,
            })
            .catch(() => undefined);
          if (start?.cancelled) {
            await cleanupIso();
            throw new Error(`Subagent spawn blocked by a hook: ${start.reason ?? 'subagent.start hook cancelled the spawn'}`);
          }
        }
        try {
          const result = await spawn({
            task,
            tools: requested ?? profile?.tools,
            botId: childBotId,
            parentSessionId: ctx.sessionId,
            provenance: childProvenance,
            profile,
            isolation: wantIsolation,
            worktreePath: iso?.info.path,
          });
          recordDecision({ delegatingBotId: ctx.botId, targetBotId: childBotId, via: 'subagent', outcome: 'success', task });
          if (opts.hooks) {
            await opts.hooks
              .emit('subagent.stop', {
                sessionId: ctx.sessionId,
                botId: ctx.botId,
                task: task.slice(0, 500),
                status: 'done' as const,
                via: 'delegate' as const,
                ...(profile?.id ? { profileId: profile.id } : {}),
              })
              .catch(() => undefined);
          }
          return { result: result.result, usage: result.usage ?? null, ...(iso ? { worktreePath: iso.info.path, worktreeBranch: iso.info.branch } : {}) };
        } catch (err) {
          recordDecision({ delegatingBotId: ctx.botId, targetBotId: childBotId, via: 'subagent', outcome: 'failed', task, error: err instanceof Error ? err.message : String(err) });
          if (opts.hooks) {
            await opts.hooks
              .emit('subagent.stop', {
                sessionId: ctx.sessionId,
                botId: ctx.botId,
                task: task.slice(0, 500),
                status: 'failed' as const,
                via: 'delegate' as const,
                error: err instanceof Error ? err.message : String(err),
                ...(profile?.id ? { profileId: profile.id } : {}),
              })
              .catch(() => undefined);
          }
          throw err;
        } finally {
          await cleanupIso();
        }
      }

      try {
        const spawned = await spawnSubagent({
          store,
          spawn,
          audit,
          maxDepth,
          parentBotId: ctx.botId,
          parentSessionId: ctx.sessionId,
          task,
          tools: requested ?? profile?.tools,
          botId: botOverride ?? ctx.botId,
          provenance: childProvenance,
          profile,
          hooks: opts.hooks,
          isolation: wantIsolation,
          worktreePath: iso?.info.path,
        });
        recordDecision({ delegatingBotId: ctx.botId, targetBotId: childBotId, via: 'subagent', outcome: 'success', task });
        return {
          result: spawned.result,
          usage: spawned.usage ?? null,
          subagentId: spawned.subagentId,
          ...(iso ? { worktreePath: iso.info.path, worktreeBranch: iso.info.branch } : {}),
        };
      } catch (err) {
        recordDecision({ delegatingBotId: ctx.botId, targetBotId: childBotId, via: 'subagent', outcome: 'failed', task, error: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        await cleanupIso();
      }
    },
  };

  return [delegateTool];
}
