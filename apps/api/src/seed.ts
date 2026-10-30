// SPDX-License-Identifier: Apache-2.0
// Seed loading: bots.json, workflows/*.json, mcp.json, and the skills dir.
// Missing seed files are tolerated (warn + empty) so the API can boot in dev
// before the coordinator drops the real seed tree.
//
// Real BotConfig (agent-runtime) requires: id, name, description,
// systemPrompt, provider, model, skills[], tools[], mcpServers[]. The loader
// requires id/name/systemPrompt and fills the rest with safe defaults.
// NOTE: a bot only sees the tools named in its `tools` allowlist
// (AgentRuntime.resolveTools) — an empty list means no tools.

import fs from 'node:fs';
import path from 'node:path';
import type { BotConfig, BotPolicy, BotPolicyRule } from '@mvp/agent-runtime';
import type { WorkflowDefinition, WorkflowNode } from '@mvp/workflows';

export interface StdioMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpMcpServer {
  url: string;
  /**
   * When true, the server requires OAuth 2.1 (authorization code + PKCE).
   * The platform connects with the stored bearer token; if no valid token
   * exists the connection fails with an "OAuth required" error pointing at
   * GET /api/mcp/oauth/start?server=<id>. Connect it once via the API/UI,
   * then restart or wait for reconnect.
   */
  oauth?: boolean;
  /**
   * CIMD (closure #50): an https URL acting as the OAuth client_id —
   * the authorization server fetches the client metadata document from
   * it instead of a dynamic-registration round-trip. Passed through to
   * McpOAuthClient when set.
   */
  cimdClientId?: string;
}

export type McpServerConfig = StdioMcpServer | HttpMcpServer;

export interface SeedData {
  bots: BotConfig[];
  workflows: WorkflowDefinition[];
  mcpServers: Record<string, McpServerConfig>;
}

function readJsonFile<T>(filePath: string, label: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(`[seed] missing ${label} at ${filePath} — continuing with empty`);
    } else {
      console.warn(`[seed] failed to parse ${label} at ${filePath}: ${(err as Error).message}`);
    }
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

const POLICY_EFFECTS = new Set(['allow', 'deny', 'require-approval']);

/** Lenient policy normalization for seed bots: drops invalid rules, keeps the rest. */
function normalizeBotPolicy(value: unknown): BotPolicy | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const rulesRaw = (value as { rules?: unknown }).rules;
  if (!Array.isArray(rulesRaw)) return undefined;
  const rules: BotPolicyRule[] = [];
  for (const raw of rulesRaw) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id) continue;
    if (typeof r.toolPattern !== 'string' || !r.toolPattern) continue;
    if (typeof r.effect !== 'string' || !POLICY_EFFECTS.has(r.effect)) continue;
    try {
      new RegExp(r.toolPattern, 'i');
    } catch {
      continue; // invalid pattern: drop the rule, don't poison the bot
    }
    rules.push({
      id: r.id,
      toolPattern: r.toolPattern,
      effect: r.effect as BotPolicyRule['effect'],
      reason: typeof r.reason === 'string' && r.reason ? r.reason : undefined,
    });
  }
  return { rules };
}

function normalizeBot(bot: unknown): BotConfig | null {
  if (typeof bot !== 'object' || bot === null) return null;
  const b = bot as Record<string, unknown>;
  if (typeof b.id !== 'string' || !b.id) return null;
  if (typeof b.name !== 'string' || !b.name) return null;
  if (typeof b.systemPrompt !== 'string' || !b.systemPrompt) return null;
  const policy = normalizeBotPolicy(b.policy);
  return {
    id: b.id,
    name: b.name,
    description: typeof b.description === 'string' ? b.description : '',
    systemPrompt: b.systemPrompt,
    provider: typeof b.provider === 'string' && b.provider ? b.provider : 'groq',
    model: typeof b.model === 'string' ? b.model : '',
    skills: stringArray(b.skills),
    tools: stringArray(b.tools),
    mcpServers: stringArray(b.mcpServers),
    ...(policy ? { policy } : {}),
  };
}

function isValidWorkflowNode(node: unknown): node is WorkflowNode {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as Record<string, unknown>;
  return (
    typeof n.id === 'string' &&
    typeof n.type === 'string' &&
    typeof n.name === 'string' &&
    (n.config === undefined || typeof n.config === 'object')
  );
}

function normalizeWorkflow(def: unknown): WorkflowDefinition | null {
  if (typeof def !== 'object' || def === null) return null;
  const d = def as Record<string, unknown>;
  if (typeof d.id !== 'string' || !d.id) return null;
  if (typeof d.name !== 'string' || !d.name) return null;
  if (!Array.isArray(d.nodes) || !d.nodes.every(isValidWorkflowNode)) return null;
  const edges = Array.isArray(d.edges)
    ? d.edges.filter(
        (e): e is [string, string] =>
          Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string',
      )
    : [];
  return {
    id: d.id,
    name: d.name,
    description: typeof d.description === 'string' ? d.description : undefined,
    nodes: (d.nodes as WorkflowNode[]).map((n) => ({
      ...n,
      config: (n.config ?? {}) as Record<string, unknown>,
    })),
    edges,
  };
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.url === 'string' && v.url) return true;
  return typeof v.command === 'string' && !!v.command;
}

export function loadSeed(seedDir: string): SeedData {
  const botsRaw = readJsonFile<unknown>(path.join(seedDir, 'bots.json'), 'bots.json');
  const bots: BotConfig[] = [];
  if (Array.isArray(botsRaw)) {
    for (const raw of botsRaw) {
      const bot = normalizeBot(raw);
      if (bot) bots.push(bot);
      else console.warn('[seed] dropped invalid bot entry (needs id, name, systemPrompt)');
    }
  }

  const workflows: WorkflowDefinition[] = [];
  const workflowsDir = path.join(seedDir, 'workflows');
  try {
    for (const file of fs.readdirSync(workflowsDir)) {
      if (!file.endsWith('.json')) continue;
      const def = readJsonFile<unknown>(path.join(workflowsDir, file), `workflows/${file}`);
      const normalized = def === null ? null : normalizeWorkflow(def);
      if (normalized) workflows.push(normalized);
      else if (def !== null) console.warn(`[seed] dropped invalid workflow definition in ${file}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    console.warn(`[seed] missing workflows/ dir at ${workflowsDir} — continuing with empty`);
  }

  const mcpRaw = readJsonFile<{ mcpServers?: Record<string, unknown> }>(
    path.join(seedDir, 'mcp.json'),
    'mcp.json',
  );
  const mcpServers: Record<string, McpServerConfig> = {};
  if (mcpRaw?.mcpServers && typeof mcpRaw.mcpServers === 'object') {
    for (const [name, cfg] of Object.entries(mcpRaw.mcpServers)) {
      if (isMcpServerConfig(cfg)) mcpServers[name] = cfg;
      else console.warn(`[seed] dropped invalid MCP server config "${name}"`);
    }
  }

  console.log(
    `[seed] loaded ${bots.length} bot(s), ${workflows.length} workflow(s), ` +
      `${Object.keys(mcpServers).length} MCP server(s) from ${seedDir}`,
  );
  return { bots, workflows, mcpServers };
}
