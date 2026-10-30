// SPDX-License-Identifier: Apache-2.0

/**
 * Per-step agent configuration (#143, Octomind parity).
 *
 * Octomind-style workflows define each step's role / model / toolset /
 * skills inline. KriyaDot agent and bot-turn nodes now carry the same
 * fields in `config`:
 *
 * ```json
 * { "id": "draft", "type": "agent", "name": "Draft",
 *   "config": { "botId": "writer", "prompt": "Draft: {{input.topic}}",
 *               "role": "senior copywriter", "model": "gpt-4o",
 *               "provider": "openai",
 *               "toolset": ["web_search"], "skills": ["seo"] } }
 * ```
 *
 * `resolveStepConfig` normalizes a raw node config (accepting the
 * `tools` alias for `toolset` and a bare string for a one-item list),
 * `validateStepConfig` rejects malformed fields, and
 * `applyStepConfigToBot` builds the *effective* bot for one step: the
 * registered bot is cloned with provider/model/tool/skill overrides and
 * the role folded into its system prompt. The registered bot object is
 * never mutated, so one bot can serve many steps with different roles.
 */

import type { BotConfig } from '@mvp/agent-runtime';
import type { WorkflowNode } from './types.js';

/** Normalized per-step config for agent / bot-turn nodes. */
export interface ResolvedStepConfig {
  botId?: string;
  role?: string;
  provider?: string;
  model?: string;
  /** Tool names enabled for this step only (from `toolset`/`tools`). */
  toolset?: string[];
  /** Skill names enabled for this step only. */
  skills?: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return undefined;
}

/** Normalize the step fields out of a raw agent/bot-turn node config. */
export function resolveStepConfig(config: Record<string, unknown>): ResolvedStepConfig {
  const step: ResolvedStepConfig = {};
  if (typeof config['botId'] === 'string' && config['botId'].length > 0) step.botId = config['botId'];
  if (typeof config['role'] === 'string' && config['role'].length > 0) step.role = config['role'];
  if (typeof config['provider'] === 'string' && config['provider'].length > 0) {
    step.provider = config['provider'];
  }
  if (typeof config['model'] === 'string' && config['model'].length > 0) step.model = config['model'];
  const toolset = stringList(config['toolset'] ?? config['tools']);
  if (toolset !== undefined) step.toolset = toolset;
  const skills = stringList(config['skills']);
  if (skills !== undefined) step.skills = skills;
  return step;
}

/** Convenience: resolve the step config of a workflow node. */
export function stepConfigOf(node: WorkflowNode): ResolvedStepConfig {
  return resolveStepConfig(asRecord(node.config));
}

function checkStringList(node: WorkflowNode, config: Record<string, unknown>, field: string): void {
  const value = config[field];
  if (value === undefined) return;
  const ok =
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0));
  if (!ok) {
    throw new Error(`node ${node.id}: config.${field} must be a string or an array of non-empty strings`);
  }
}

/**
 * Validate the per-step fields of an agent/bot-turn node. Throws with a
 * message naming the node and field. Other node types are ignored.
 */
export function validateStepConfig(node: WorkflowNode): void {
  if (node.type !== 'agent' && node.type !== 'bot-turn') return;
  const config = asRecord(node.config);
  for (const field of ['role', 'provider', 'model'] as const) {
    const value = config[field];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new Error(`node ${node.id}: config.${field} must be a non-empty string`);
    }
  }
  checkStringList(node, config, 'toolset');
  checkStringList(node, config, 'tools');
  checkStringList(node, config, 'skills');
}

/**
 * Build the effective bot for one step: a clone of `bot` with the
 * step's provider/model/toolset/skills applied and its role folded
 * into the system prompt. Returns `bot` itself when the step sets
 * nothing (no needless clone).
 */
export function applyStepConfigToBot(bot: BotConfig, step: ResolvedStepConfig): BotConfig {
  if (
    step.role === undefined &&
    step.provider === undefined &&
    step.model === undefined &&
    step.toolset === undefined &&
    step.skills === undefined
  ) {
    return bot;
  }
  const effective: BotConfig = { ...bot };
  if (step.provider !== undefined) effective.provider = step.provider;
  if (step.model !== undefined) effective.model = step.model;
  if (step.toolset !== undefined) effective.tools = [...step.toolset];
  if (step.skills !== undefined) effective.skills = [...step.skills];
  if (step.role !== undefined) {
    const base = bot.systemPrompt?.trim() ?? '';
    effective.systemPrompt = base
      ? `${base}\n\nRole for this workflow step: ${step.role}`
      : `Role for this workflow step: ${step.role}`;
  }
  return effective;
}
