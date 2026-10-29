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
  }): { runId: string; botName: string } | { error: string };
  listBackgroundRuns(originSessionId: string): BackgroundRunRecord[];
  stopBackgroundRun(runId: string): boolean;
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
