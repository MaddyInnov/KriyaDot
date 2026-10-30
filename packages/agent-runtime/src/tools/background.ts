// SPDX-License-Identifier: Apache-2.0
/**
 * Background delegation tools (Octomind parity): hand a self-contained
 * task to a specialist — a roster bot or an ephemeral bot defined
 * inline — WITHOUT blocking the current turn. The result comes back as
 * an injected message at the start of the session's next turn.
 */

import type { BackgroundRunRecord } from '../background-runs.js';
import type { BotConfig, ToolDefinition } from '../types.js';

export interface BackgroundRunHost {
  startBackgroundRun(input: {
    originBot: BotConfig;
    originSessionId: string;
    task: string;
    specialistBotId?: string;
    ephemeral?: { name: string; systemPrompt: string; model?: string; providerId?: string };
    tools?: string[];
    profileId?: string;
    /** CA-5: run the specialist in an auto-created git worktree. */
    isolation?: 'worktree' | 'none';
  }): { runId: string; botName: string } | { error: string };
  listBackgroundRuns(originSessionId: string): BackgroundRunRecord[];
  stopBackgroundRun(runId: string): boolean;
  /** Closure #14: resume a stopped/failed run (optional host support). */
  resumeBackgroundRun?(runId: string): { runId: string; botName: string } | { error: string };
}

export function createBackgroundTools(host: BackgroundRunHost & { getBot?: (botId: string) => BotConfig | undefined }): ToolDefinition[] {
  return [
    {
      name: 'delegate_background',
      description:
        'Delegate a self-contained task to a specialist bot IN THE BACKGROUND and keep working. ' +
        'Either name a roster bot (specialistBotId) or define an ephemeral specialist inline ' +
        '(ephemeralName + ephemeralPrompt). The result is injected into this session at the ' +
        'start of the next turn. Returns the run id immediately.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The complete, self-contained task for the specialist.' },
          specialistBotId: { type: 'string', description: 'Roster bot id to run the task.' },
          ephemeralName: { type: 'string', description: 'Name for an ephemeral specialist (alternative to specialistBotId).' },
          ephemeralPrompt: { type: 'string', description: 'System prompt for the ephemeral specialist.' },
          ephemeralModel: { type: 'string', description: 'Model override for the ephemeral specialist.' },
          profileId: { type: 'string', description: 'Sub-agent profile id (see the specialist profile library) — spawns an ephemeral specialist with that profile prompt and suggested tools.' },
          isolation: { type: 'string', enum: ['worktree', 'none'], description: 'CA-5: "worktree" runs the specialist in an auto-created git worktree of the origin workspace (also settable on the agent definition itself).' },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tool names the ephemeral specialist may use (default: none).',
          },
        },
        required: ['task'],
      },
      mutating: true,
      handler: async (args, ctx) => {
        const task = typeof args.task === 'string' ? args.task.trim() : '';
        if (!task) return { error: 'task is required' };
        const originBot = host.getBot?.(ctx.botId);
        if (!originBot) return { error: 'origin bot not resolvable in this host' };
        const ephemeral =
          typeof args.ephemeralPrompt === 'string' && args.ephemeralPrompt
            ? {
                name: typeof args.ephemeralName === 'string' && args.ephemeralName ? args.ephemeralName : 'Specialist',
                systemPrompt: args.ephemeralPrompt,
                model: typeof args.ephemeralModel === 'string' ? args.ephemeralModel : undefined,
              }
            : undefined;
        const result = host.startBackgroundRun({
          originBot,
          originSessionId: ctx.sessionId,
          task,
          specialistBotId: typeof args.specialistBotId === 'string' ? args.specialistBotId : undefined,
          ephemeral,
          profileId: typeof args.profileId === 'string' ? args.profileId : undefined,
          isolation: args.isolation === 'worktree' ? 'worktree' : undefined,
          tools: Array.isArray(args.tools) ? (args.tools as string[]) : undefined,
        });
        if ('error' in result) return { error: result.error };
        return {
          runId: result.runId,
          botName: result.botName,
          note: 'Running in the background. The result will be injected into this session at the start of the next turn; use list_background_runs to check status.',
        };
      },
    },
    {
      name: 'list_background_runs',
      description: 'List background specialist runs delegated from this session, with their status.',
      parameters: { type: 'object', properties: {} },
      mutating: false,
      handler: async (_args, ctx) => {
        const runs = host.listBackgroundRuns(ctx.sessionId).map((r) => ({
          runId: r.id,
          botName: r.botName,
          ephemeral: r.ephemeral,
          status: r.status,
          task: r.task.slice(0, 200),
          ...(r.error ? { error: r.error } : {}),
        }));
        return { runs };
      },
    },
    {
      name: 'resume_background_run',
      description: 'Resume a stopped or failed background specialist run by its run id. The specialist is re-dispatched with the same task plus a summary of the previous attempt.',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
      },
      mutating: true,
      handler: async (args) => {
        const runId = typeof args.runId === 'string' ? args.runId : '';
        if (!host.resumeBackgroundRun) return { error: 'resume is not supported by this host' };
        const res = host.resumeBackgroundRun(runId);
        return 'error' in res ? { error: res.error } : { resumed: true, runId: res.runId, botName: res.botName };
      },
    },
    {
      name: 'stop_background_run',
      description: 'Stop a running background specialist run by its run id.',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
      },
      mutating: true,
      handler: async (args) => {
        const runId = typeof args.runId === 'string' ? args.runId : '';
        return host.stopBackgroundRun(runId)
          ? { stopped: true, runId }
          : { stopped: false, reason: 'no running run with that id' };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Named ephemeral-agent lifecycle tools (closure #18): the one-shot
// ephemeral spawn in delegate_background gains a named lifecycle —
// register an agent once, enable/disable/remove it, and re-invoke it
// BY NAME in later turns. The registry (NamedAgentRegistry in
// subagent-profiles.ts) owns the state; these tools are its surface,
// and invocation rides the same startBackgroundRun host path as every
// other background delegation.
// ---------------------------------------------------------------------------

import { NamedAgentRegistry, type SubagentProfile } from '../subagent-profiles.js';

export interface NamedAgentHost {
  /** The lifecycle registry (host-owned so it can be persisted). */
  namedAgents: NamedAgentRegistry;
  /** Same dispatch path as delegate_background. */
  startBackgroundRun: BackgroundRunHost['startBackgroundRun'];
}

export function createNamedAgentTools(host: NamedAgentHost & { getBot?: (botId: string) => BotConfig | undefined }): ToolDefinition[] {
  const reg = host.namedAgents;
  return [
    {
      name: 'register_named_agent',
      description:
        'Register a NAMED ephemeral specialist agent (name + system prompt + suggested tools) so it can be ' +
        're-invoked by name later with invoke_named_agent. Registration persists for the life of the host registry.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique agent name (also its id).' },
          systemPrompt: { type: 'string', description: 'System prompt defining the specialist.' },
          description: { type: 'string', description: 'What this specialist is for.' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Suggested tool names for the specialist.' },
        },
        required: ['name', 'systemPrompt'],
      },
      mutating: true,
      handler: async (args) => {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        const systemPrompt = typeof args.systemPrompt === 'string' ? args.systemPrompt.trim() : '';
        if (!name || !systemPrompt) return { error: 'name and systemPrompt are required' };
        const profile: SubagentProfile = {
          id: name,
          name,
          specialty: '',
          description: typeof args.description === 'string' ? args.description : '',
          systemPrompt,
          suggestedTools: Array.isArray(args.tools) ? (args.tools as string[]) : [],
        };
        const entry = reg.add(profile);
        return { registered: true, name: entry.profile.name, enabled: entry.enabled };
      },
    },
    {
      name: 'list_named_agents',
      description: 'List registered named ephemeral agents with their enabled state and invoke counts.',
      parameters: { type: 'object', properties: {} },
      mutating: false,
      handler: async () => ({
        agents: reg.list().map((a) => ({
          name: a.profile.name,
          description: a.profile.description,
          enabled: a.enabled,
          invokeCount: a.invokeCount,
        })),
      }),
    },
    {
      name: 'set_named_agent_enabled',
      description: 'Enable or disable a named ephemeral agent. A disabled agent cannot be invoked.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['name', 'enabled'],
      },
      mutating: true,
      handler: async (args) => {
        const name = typeof args.name === 'string' ? args.name : '';
        const enabled = args.enabled === true;
        return reg.setEnabled(name, enabled)
          ? { name, enabled }
          : { error: `no named agent "${name}"` };
      },
    },
    {
      name: 'remove_named_agent',
      description: 'Remove a registered named ephemeral agent entirely.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      mutating: true,
      handler: async (args) => {
        const name = typeof args.name === 'string' ? args.name : '';
        return reg.remove(name) ? { removed: true, name } : { error: `no named agent "${name}"` };
      },
    },
    {
      name: 'invoke_named_agent',
      description:
        'Re-invoke a previously registered named ephemeral agent BY NAME on a new task, in the background. ' +
        'Fails for unknown or disabled agents. The result is injected into this session at the next turn, like delegate_background.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The registered agent name.' },
          task: { type: 'string', description: 'The complete, self-contained task.' },
        },
        required: ['name', 'task'],
      },
      mutating: true,
      handler: async (args, ctx) => {
        const name = typeof args.name === 'string' ? args.name : '';
        const task = typeof args.task === 'string' ? args.task.trim() : '';
        if (!task) return { error: 'task is required' };
        const ephemeral = reg.ephemeralFor(name);
        if (!ephemeral) {
          const known = reg.get(name);
          return { error: known ? `named agent "${name}" is disabled` : `no named agent "${name}" — register it first` };
        }
        const originBot = host.getBot?.(ctx.botId);
        if (!originBot) return { error: 'origin bot not resolvable in this host' };
        const result = host.startBackgroundRun({
          originBot,
          originSessionId: ctx.sessionId,
          task,
          ephemeral: { name: ephemeral.name, systemPrompt: ephemeral.systemPrompt },
          tools: ephemeral.tools,
        });
        if ('error' in result) return { error: result.error };
        return { runId: result.runId, botName: result.botName, agent: ephemeral.name };
      },
    },
  ];
}
