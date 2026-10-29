// SPDX-License-Identifier: Apache-2.0
// Host wiring for Workstream A's `delegate` tool (Phase 2).
//
// Provides the real `SubagentSpawnFn`: a child AgentRuntime turn under the
// SAME governance policy as the parent, with the tool subset honored
// (default: the parent bot's tools minus `delegate` itself — the tool also
// strips it defensively). The child's runtime session id is the id minted by
// spawnSubagent, so SubagentStore.getDepth() walks the real session chain
// and the nesting limit holds for grandchildren.
//
// Phase 1 trust floor is preserved: the child goes through the identical
// classify → evaluate → approval → execute path (MCP tools stay
// approval-gated inside the child; child tool outputs are tagged untrusted).

import path from 'node:path';
import {
  AgentRuntime,
  SubagentStore,
  createDelegateTools,
  createEmbedderFromEnv,
  resolveBotWorkspaceDir,
} from '@mvp/agent-runtime';
import type {
  BotConfig,
  StreamEvent,
  SubagentSpawnFn,
  TokenUsage,
  ToolDefinition,
} from '@mvp/agent-runtime';
import type { GovernanceAdapter } from './governance-adapter.js';

import { openDb } from '@mvp/agent-runtime';
import type { DatabaseSync } from 'node:sqlite';

export interface DelegateWiringOpts {
  registry: Map<string, ToolDefinition>;
  dataDir: string;
  skillsDir: string;
  governanceAdapter: GovernanceAdapter;
  getBotConfig: (botId: string) => BotConfig | undefined;
  /**
   * Workspace root — the external ACP agent's cwd is confined here.
   */
  workspaceDir: string;
  /**
   * Audit sink — receives `subagent.spawned` / `subagent.finished` entries
   * (without `ts`; the gateway stamps it). They surface in Audit/Activity.
   */
  audit: (
    action: string,
    fields: { actor?: string; sessionId?: string; toolName?: string; decision?: string; detail?: unknown },
  ) => void;
  defaultProviderId?: string;
}

/** Ensure the minted child session id has a row in the sessions table. */
function ensureSessionRow(dbPath: string, sessionId: string, botId: string): void {
  const db = openDb(dbPath);
  try {
    db.prepare('INSERT OR IGNORE INTO sessions (id, bot_id, created_at) VALUES (?, ?, ?)').run(
      sessionId,
      botId,
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

/**
 * Register the `delegate` tool in the registry. The spawn implementation
 * builds a throwaway child AgentRuntime per call (cheap: shares the db files
 * and governance adapter; no HTTP server involved).
 */
export function registerDelegateTools(opts: DelegateWiringOpts): void {
  const dbPath = path.join(opts.dataDir, 'agent.db');
  const store = new SubagentStore(path.join(opts.dataDir, 'subagents.db'));

  const spawn: SubagentSpawnFn = async (input) => {
    const botId = input.botId ?? '';
    const baseBot = opts.getBotConfig(botId);
    if (!baseBot) {
      throw new Error(`delegate: unknown bot "${botId}" — cannot spawn a subagent for it`);
    }
    // Profile-based ephemeral specialist (item 16): profile prompt/tools win.
    const bot = input.profile
      ? { ...baseBot, name: input.profile.name, systemPrompt: input.profile.systemPrompt, tools: input.profile.tools }
      : baseBot;
    if (input.profile) input = { ...input, tools: input.tools ?? input.profile.tools };
    // Default subset: the parent bot's tools minus `delegate` (no unbounded
    // recursion). Explicit subsets were already stripped by the tool itself;
    // strip again defensively.
    const allowedNames = (input.tools ?? bot.tools).filter((t) => t !== 'delegate');
    const childRegistry = new Map<string, ToolDefinition>();
    for (const name of allowedNames) {
      const def = opts.registry.get(name);
      if (def) childRegistry.set(name, def);
    }

    const childSessionId = input.sessionId ?? `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    ensureSessionRow(dbPath, childSessionId, bot.id);

    const childRuntime = new AgentRuntime({
      dbPath,
      skillsDir: opts.skillsDir,
      governance: opts.governanceAdapter,
      toolRegistry: childRegistry,
      defaultProviderId: opts.defaultProviderId ?? 'groq',
      // Octomind parity wiring (same as the server runtime): per-bot
      // workspaces for project instructions/policy/tools + the shared
      // platform embedder for discovery.
      workspaceDirForBot: (bot) =>
        resolveBotWorkspaceDir({
          botWorkspace: bot.workspace,
          globalWorkspaceDir: opts.workspaceDir,
          dataDir: opts.dataDir,
        }),
      embedder: createEmbedderFromEnv(),
    });

    // Collect the child's final text from the token stream. (runTurn returns
    // usage; content arrives as `token` events.)
    let result = '';
    let usage: TokenUsage | undefined;
    const onEvent = async (e: StreamEvent): Promise<void> => {
      if (e.type === 'token') result += e.content;
      else if (e.type === 'done') usage = e.usage;
    };
    try {
      const returned = await childRuntime.runTurn({
        bot,
        message: input.task,
        sessionId: childSessionId,
        // P1 #13: inherit the parent's origin chain so the consent rule and
        // untrusted-content fencing apply to the child's turn too.
        provenance: input.provenance,
        onEvent,
      });
      usage = usage ?? returned;
    } finally {
      childRuntime.close();
    }
    const text = result.trim();
    if (!text) {
      throw new Error('delegate: subagent produced no text output');
    }
    return { result: text, usage, sessionId: childSessionId };
  };

  const audit = (entry: { type: string; sessionId?: string; botId?: string; detail?: unknown }): void => {
    try {
      opts.audit(entry.type, {
        actor: 'subagent',
        sessionId: entry.sessionId,
        detail: { botId: entry.botId, ...(entry.detail as Record<string, unknown> | undefined) },
      });
    } catch {
      // Audit failures must never break delegation.
    }
  };

  for (const tool of createDelegateTools({
    spawn,
    store,
    audit,
    getBotConfig: opts.getBotConfig,
    workspaceDir: opts.workspaceDir,
  })) {
    if (!opts.registry.has(tool.name)) {
      opts.registry.set(tool.name, tool);
    }
  }
}
