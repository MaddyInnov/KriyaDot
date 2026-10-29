// SPDX-License-Identifier: Apache-2.0
// "Set me up" (W12a): a new bot configures itself from ONE sentence.
//
// The user describes the bot they want ("I need a bot that watches my
// Gmail and drafts replies every morning"). A single setup turn against
// the configured provider produces a PROPOSED BotConfig — name, persona /
// instructions, a tool selection drawn ONLY from the real tool registry,
// routine suggestions in the existing routine shape, and MCP/app
// suggestions drawn only from configured servers. The proposal is inert
// data: nothing is created until the user approves it in the UI and the
// API's apply endpoint re-validates and creates the bot + routines
// through the existing roster-import and RoutineStore paths.
//
// This module is the pure generation/parsing half (provider injected, so
// tests run on MockProvider with zero paid usage). All side effects live
// in the API layer (apps/api/src/bot-setup-routes.ts).

import type { ChatMessage, LLMProvider } from './types.js';

/** One suggested routine: a RoutineStore.create input minus botId. */
export interface BotSetupRoutineSuggestion {
  name: string;
  promptTemplate: string;
  /** Raw schedule object in the routine-schedules shape (API validates). */
  schedule?: Record<string, unknown>;
}

/** A proposed bot configuration awaiting user approval. Creates nothing. */
export interface BotSetupProposal {
  /** Slug id for the new bot (unique against the existing roster). */
  id: string;
  name: string;
  description: string;
  /** Persona / instructions for the bot. */
  systemPrompt: string;
  /** MBTI persona template when the model suggested a valid one. */
  persona?: string;
  provider: string;
  model: string;
  /** Tool names — guaranteed to be a subset of the real registry. */
  tools: string[];
  skills: string[];
  /** MCP server names — guaranteed subset of the configured servers. */
  mcpServers: string[];
  routines: BotSetupRoutineSuggestion[];
  /** The user's original sentence, kept for the approval card. */
  sourceSentence: string;
  /** Tool names the model asked for that do NOT exist (transparency). */
  droppedTools: string[];
  /** MCP servers the model asked for that are not configured. */
  droppedMcpServers: string[];
}

export interface GenerateBotSetupDeps {
  /** Provider for the setup turn (the chief's / default bot's provider). */
  provider: LLMProvider;
  model: string;
  /** Every tool name in the real registry — the only selectable tools. */
  availableTools: readonly string[];
  /** Configured MCP server names — the only selectable servers. */
  availableMcpServers: readonly string[];
  /** Known skill names — the only selectable skills. */
  availableSkills: readonly string[];
  defaultProvider: string;
  defaultModel: string;
  /** Existing bot ids the proposal id must not collide with. */
  existingBotIds: readonly string[];
}

const CAPS = {
  sentence: 1000,
  name: 120,
  description: 500,
  systemPrompt: 8000,
  tools: 40,
  skills: 20,
  mcpServers: 20,
  routines: 5,
  routineName: 120,
  routinePrompt: 4000,
} as const;

const ROUTINE_SCHEDULE_KINDS = new Set(['once', 'daily', 'cron', 'interval']);
const PERSONA_RE = /^[IE][NS][TF][JP]$/i;

/** Slugify a display name into a bot id (letters/digits/_/-, max 64). */
export function slugifyBotId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug || 'new-bot';
}

function uniqueBotId(base: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 60)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cleanString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim());
  }
  return out;
}

/** Extract the first JSON object from a model reply (fences tolerated). */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('setup model did not return a JSON object');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error('setup model returned invalid JSON');
  }
}

/**
 * Sanitize a raw model proposal against the real catalogs. Invalid tool /
 * server / skill names are dropped (and reported on the proposal), caps
 * are enforced, and the id is made unique. Throws only when the proposal
 * has no usable name — everything else degrades to safe defaults.
 */
export function sanitizeBotSetupProposal(
  raw: unknown,
  deps: Pick<GenerateBotSetupDeps, 'availableTools' | 'availableMcpServers' | 'availableSkills' | 'defaultProvider' | 'defaultModel' | 'existingBotIds'>,
  sourceSentence: string,
): BotSetupProposal {
  if (!isRecord(raw)) throw new Error('setup proposal must be a JSON object');
  const name = cleanString(raw.name, CAPS.name);
  if (!name) throw new Error('setup proposal is missing a bot name');

  const description = cleanString(raw.description, CAPS.description) ?? '';
  const systemPrompt =
    cleanString(raw.systemPrompt, CAPS.systemPrompt) ??
    cleanString(raw.instructions, CAPS.systemPrompt) ??
    `You are ${name}. ${description}`.trim();

  const availableTools = new Set(deps.availableTools);
  const requestedTools = [...new Set(stringList(raw.tools))];
  const tools = requestedTools.filter((t) => availableTools.has(t)).slice(0, CAPS.tools);
  const droppedTools = requestedTools.filter((t) => !availableTools.has(t));
  // Never ship a bot with zero tools when the registry has safe basics.
  if (tools.length === 0) {
    for (const fallback of ['web_search', 'web_fetch', 'notes_read', 'notes_search']) {
      if (availableTools.has(fallback)) tools.push(fallback);
    }
  }

  const availableMcp = new Set(deps.availableMcpServers);
  const requestedMcp = [...new Set(stringList(raw.mcpServers))];
  const mcpServers = requestedMcp.filter((s) => availableMcp.has(s)).slice(0, CAPS.mcpServers);
  const droppedMcpServers = requestedMcp.filter((s) => !availableMcp.has(s));

  const availableSkills = new Set(deps.availableSkills);
  const skills = [...new Set(stringList(raw.skills))]
    .filter((s) => availableSkills.has(s))
    .slice(0, CAPS.skills);

  const routines: BotSetupRoutineSuggestion[] = [];
  if (Array.isArray(raw.routines)) {
    for (const item of raw.routines) {
      if (!isRecord(item)) continue;
      const rName = cleanString(item.name, CAPS.routineName);
      const promptTemplate = cleanString(item.promptTemplate, CAPS.routinePrompt);
      if (!rName || !promptTemplate) continue;
      const routine: BotSetupRoutineSuggestion = { name: rName, promptTemplate };
      if (isRecord(item.schedule) && typeof item.schedule.kind === 'string' && ROUTINE_SCHEDULE_KINDS.has(item.schedule.kind)) {
        routine.schedule = item.schedule;
      }
      routines.push(routine);
      if (routines.length >= CAPS.routines) break;
    }
  }

  const personaRaw = cleanString(raw.persona, 8);
  const persona = personaRaw && PERSONA_RE.test(personaRaw) ? personaRaw.toUpperCase() : undefined;

  return {
    id: uniqueBotId(slugifyBotId(cleanString(raw.id, 64) ?? name), deps.existingBotIds),
    name,
    description,
    systemPrompt,
    ...(persona ? { persona } : {}),
    provider: cleanString(raw.provider, 60) ?? deps.defaultProvider,
    model: cleanString(raw.model, 120) ?? deps.defaultModel,
    tools,
    skills,
    mcpServers,
    routines,
    sourceSentence: sourceSentence.slice(0, CAPS.sentence),
    droppedTools,
    droppedMcpServers,
  };
}

/** Build the setup-turn messages. Exported for tests/inspection. */
export function buildBotSetupMessages(sentence: string, deps: GenerateBotSetupDeps): ChatMessage[] {
  const system = [
    'You configure a new AI assistant bot from a one-sentence request.',
    'Reply with ONE JSON object and nothing else, in exactly this shape:',
    '{',
    '  "name": "short display name",',
    '  "description": "one sentence describing the bot",',
    '  "systemPrompt": "full instructions/persona for the bot",',
    '  "persona": "optional MBTI type like INTJ, or omit",',
    '  "tools": ["tool names chosen ONLY from the available tools list"],',
    '  "skills": ["skill names chosen ONLY from the available skills list"],',
    '  "mcpServers": ["server names chosen ONLY from the available MCP servers list"],',
    '  "routines": [{ "name": "...", "promptTemplate": "the prompt the bot runs",',
    '                 "schedule": { "kind": "daily", "timezone": "UTC", "enabled": true,',
    '                               "overlap": "skip", "time": "08:00", "weekdays": [1,2,3,4,5] } }]',
    '}',
    'Rules: never invent tool, skill, or server names — anything not in the lists is discarded.',
    'Suggest routines only when the request implies recurring work; schedule kinds allowed: once, daily, cron, interval.',
    'Keep the tool list minimal for the job. Do not include provider or model fields.',
  ].join('\n');
  const user = [
    `Request: ${sentence.slice(0, CAPS.sentence)}`,
    '',
    `Available tools: ${deps.availableTools.join(', ') || '(none)'}`,
    `Available skills: ${deps.availableSkills.join(', ') || '(none)'}`,
    `Available MCP servers: ${deps.availableMcpServers.join(', ') || '(none)'}`,
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Run the setup turn and return the sanitized proposal. Pure with respect
 * to the workspace: creates nothing, persists nothing.
 */
export async function generateBotSetupProposal(
  sentence: string,
  deps: GenerateBotSetupDeps,
): Promise<BotSetupProposal> {
  const clean = sentence.trim().slice(0, CAPS.sentence);
  if (!clean) throw new Error('sentence is required');
  const result = await deps.provider.chat(buildBotSetupMessages(clean, deps), [], { model: deps.model });
  const raw = extractJsonObject(result.content ?? '');
  return sanitizeBotSetupProposal(raw, deps, clean);
}
