// SPDX-License-Identifier: Apache-2.0
// Runtime adapters: turn an installed plugin into the shapes the rest of
// KriyaDot already speaks.
//
//   tool plugins    → PluginToolDefinition[] — structurally identical to
//                     @mvp/agent-runtime's ToolDefinition (name, description,
//                     parameters JSON-Schema, handler, mutating), with names
//                     prefixed `plugin:<id>:` so they can be merged into the
//                     tool registry Map verbatim. This package defines the
//                     shape locally to stay dependency-free.
//   hook plugins    → a handler returning the HookBus result union
//                     (void | { cancel } | { inject } | { transform }).
//   channel plugins → PluginMessageProvider — the messaging.ts
//                     MessageProvider shape ({ id, name, send }) plus poll().
//   skill plugins   → PluginSkillDescriptor — the skill-store shape
//                     ({ name, description, content, sha256 } + location).
//   ui plugins      → PluginUiDescriptor — static dir + title for the API
//                     to serve under sandboxed headers.
//
// Channel poll model: executable plugins are spawned per invocation and
// are stateless between calls, so inbound delivery is PULL-based. The
// host calls provider.poll() on its own interval; the plugin returns the
// messages it has accumulated since the last poll (a plugin that needs to
// buffer between calls keeps its queue in a file inside its own plugin
// directory — see examples/demo-channel). There is no push callback: a
// spawned-per-call process has no listener to push to.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { PluginManifest } from './manifest.js';
import { invokePluginRpc, type InvokeOptions } from './rpc.js';

/** An installed plugin as the runtime sees it: manifest + on-disk dir. */
export interface PluginRuntimeTarget {
  manifest: PluginManifest;
  /** Absolute plugin directory. */
  dir: string;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface PluginToolContext {
  sessionId: string;
  botId: string;
  [key: string]: unknown;
}

/** ToolDefinition-compatible shape (see @mvp/agent-runtime types.ts). */
export interface PluginToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: PluginToolContext) => Promise<unknown>;
  mutating?: boolean;
}

export const pluginToolName = (pluginId: string, tool: string): string => `plugin:${pluginId}:${tool}`;

interface WireTool {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  mutating?: unknown;
}

const WIRE_TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Fetch a tool plugin's tools/list and adapt each entry to a ToolDefinition. */
export async function listPluginTools(
  target: PluginRuntimeTarget,
  opts: InvokeOptions = {},
): Promise<PluginToolDefinition[]> {
  const raw = await invokePluginRpc<{ tools?: WireTool[] }>(target, 'tools/list', {}, opts);
  const wire = Array.isArray(raw?.tools) ? raw.tools : [];
  const out: PluginToolDefinition[] = [];
  for (const t of wire) {
    if (typeof t.name !== 'string' || !WIRE_TOOL_NAME_RE.test(t.name)) continue;
    const toolName = t.name;
    out.push({
      name: pluginToolName(target.manifest.id, toolName),
      description: typeof t.description === 'string' ? t.description : '',
      parameters:
        typeof t.parameters === 'object' && t.parameters !== null
          ? (t.parameters as Record<string, unknown>)
          : { type: 'object', properties: {} },
      ...(t.mutating === true ? { mutating: true } : {}),
      handler: async (args: Record<string, unknown>) => {
        const result = await invokePluginRpc(target, 'tools/call', { name: toolName, args }, opts);
        return result;
      },
    });
  }
  return out;
}

/** Call one tool on a tool plugin directly (no list round-trip). */
export async function callPluginTool(
  target: PluginRuntimeTarget,
  tool: string,
  args: Record<string, unknown>,
  opts: InvokeOptions = {},
): Promise<unknown> {
  return invokePluginRpc(target, 'tools/call', { name: tool, args }, opts);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** HookBus handler-result union (see @mvp/agent-runtime hooks.ts). */
export type PluginHookResult =
  | void
  | { cancel: true; reason?: string }
  | { inject: string }
  | { transform: string };

function sanitizeHookResult(raw: unknown): PluginHookResult {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.cancel === true) return { cancel: true, ...(typeof r.reason === 'string' ? { reason: r.reason } : {}) };
  if (typeof r.inject === 'string') return { inject: r.inject };
  if (typeof r.transform === 'string') return { transform: r.transform };
  return undefined;
}

/** Invoke a hook plugin for one event; result sanitized to the HookBus union. */
export async function invokePluginHook(
  target: PluginRuntimeTarget,
  event: string,
  payload: unknown,
  opts: InvokeOptions = {},
): Promise<PluginHookResult> {
  const raw = await invokePluginRpc(target, 'hooks/invoke', { event, payload }, opts);
  return sanitizeHookResult(raw);
}

/**
 * Build a HookBus-compatible handler bound to one event:
 *   bus.on('turn.ending', pluginHookHandler(target, 'turn.ending'))
 */
export function pluginHookHandler(
  target: PluginRuntimeTarget,
  event: string,
  opts: InvokeOptions = {},
): (payload: unknown) => Promise<PluginHookResult> {
  return (payload: unknown) => invokePluginHook(target, event, payload, opts);
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface PluginInboundMessage {
  id: string;
  from?: string;
  chatId?: string;
  text?: string;
  receivedAt: number;
}

/** MessageProvider-compatible shape (see apps/api messaging.ts) + poll(). */
export interface PluginMessageProvider {
  /** Registry id: `plugin-<pluginId>` (colon-free so it survives URL params). */
  id: string;
  name: string;
  pluginId: string;
  send(to: string, text: string): Promise<{ ok: boolean; id?: string }>;
  /** Pull inbound messages accumulated since the last poll. */
  poll(): Promise<PluginInboundMessage[]>;
}

export function createPluginChannelProvider(
  target: PluginRuntimeTarget,
  opts: InvokeOptions = {},
): PluginMessageProvider {
  const pluginId = target.manifest.id;
  return {
    id: `plugin-${pluginId}`,
    name: target.manifest.name,
    pluginId,
    async send(to: string, text: string) {
      const raw = await invokePluginRpc<{ ok?: unknown; id?: unknown }>(target, 'channel/send', { to, text }, opts);
      return { ok: raw?.ok === true, ...(typeof raw?.id === 'string' ? { id: raw.id } : {}) };
    },
    async poll() {
      const raw = await invokePluginRpc<{ messages?: unknown }>(target, 'channel/poll', {}, opts);
      if (!Array.isArray(raw?.messages)) return [];
      const out: PluginInboundMessage[] = [];
      for (const m of raw.messages as Array<Record<string, unknown>>) {
        if (typeof m !== 'object' || m === null) continue;
        out.push({
          id: typeof m.id === 'string' ? m.id : `plugin-${pluginId}-${out.length}`,
          ...(typeof m.from === 'string' ? { from: m.from } : {}),
          ...(typeof m.chatId === 'string' ? { chatId: m.chatId } : {}),
          ...(typeof m.text === 'string' ? { text: m.text } : {}),
          receivedAt: typeof m.receivedAt === 'number' ? m.receivedAt : Date.now(),
        });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface PluginSkillDescriptor {
  pluginId: string;
  /** Skill name from SKILL.md frontmatter (falls back to the plugin id). */
  name: string;
  description: string;
  /** Full SKILL.md contents. */
  content: string;
  sha256: string;
  /** Absolute path of SKILL.md. */
  skillFile: string;
  /** Absolute plugin directory (extra skill files live alongside). */
  dir: string;
}

/** Minimal frontmatter reader (--- name:/description: lines), no YAML dep. */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = content.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const value = m[2]!.replace(/^["']|["']$/g, '').trim();
    if (m[1] === 'name') out.name = value;
    if (m[1] === 'description') out.description = value;
  }
  return out;
}

/** Read a skill plugin's SKILL.md into the skill-store descriptor shape. */
export function pluginSkillDescriptor(target: PluginRuntimeTarget): PluginSkillDescriptor {
  const skillFile = join(target.dir, 'SKILL.md');
  if (!existsSync(skillFile)) {
    throw new Error(`skill plugin "${target.manifest.id}" has no SKILL.md at its root`);
  }
  const content = readFileSync(skillFile, 'utf8');
  const fm = parseSkillFrontmatter(content);
  return {
    pluginId: target.manifest.id,
    name: fm.name || target.manifest.id,
    description: fm.description || target.manifest.description,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    skillFile,
    dir: target.dir,
  };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export interface PluginUiDescriptor {
  pluginId: string;
  title: string;
  /** Absolute static-asset directory to serve. */
  dir: string;
  /** Entry document served for the panel root. */
  indexFile: string;
  /** Suggested mount path in the host API. */
  mountPath: string;
}

export function pluginUiDescriptor(target: PluginRuntimeTarget): PluginUiDescriptor {
  const ui = target.manifest.ui;
  if (!ui) throw new Error(`plugin "${target.manifest.id}" has no ui spec`);
  const dir = resolve(target.dir, ui.dir);
  const root = resolve(target.dir);
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error(`plugin "${target.manifest.id}" ui.dir escapes the plugin directory`);
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`plugin "${target.manifest.id}" ui.dir not found: ${ui.dir}`);
  }
  return {
    pluginId: target.manifest.id,
    title: ui.title,
    dir,
    indexFile: join(dir, 'index.html'),
    mountPath: `/plugins/${target.manifest.id}/ui/`,
  };
}
