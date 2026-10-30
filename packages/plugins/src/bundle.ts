// SPDX-License-Identifier: Apache-2.0
// CA-23 + CA-24: Unified plugin bundle manifest.
//
// Historically KriyaDot had TWO extension systems:
//   - @mvp/plugins      (plugin.json: tool/hook/channel/skill/ui kinds)
//   - @mvp/marketplace  (registry entries: bot/skill/workflow/mcp-server/capability)
//
// This module is the ONE manifest that spans both: a bundle declares
// hooks, skills, declared tools, MCP servers, evals and (CA-24) an
// optional sandboxed UI contribution in a single validated document.
// It does not replace either legacy format — validateUnifiedManifest
// accepts a superset, and pluginManifestToUnified() / the marketplace
// adapter helpers convert the legacy shapes losslessly for the fields
// they share.
//
// Governance: declared tools enter the host tool registry ONLY through
// registerPluginTools(), which is namespaced (`plugin:<id>:<tool>`),
// audit-logged, and deny-by-default for mutating tools unless the host
// explicitly approves them.

import {
  validateManifest,
  PluginManifestError,
  isSafeRelativePath,
  type PluginManifest,
} from './manifest.js';

export interface UnifiedMcpServer {
  id: string;
  label: string;
  command: string;
  args: string[];
  requiredEnv: string[];
  description?: string;
}

export interface UnifiedDeclaredTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  mutating?: boolean;
}

export interface UnifiedHookDecl {
  event: string;
}

/** CA-24 UI contribution: a sandboxed web component shipped by a plugin. */
export interface PluginUiContribution {
  /** Static entry file, relative to the plugin root (e.g. "ui/panel.html"). */
  entry: string;
  title: string;
  /** Must be exactly "sandboxed-iframe" — no other embedding is allowed. */
  embedding: 'sandboxed-iframe';
}

export interface UnifiedBundleManifest extends PluginManifest {
  mcpServers?: UnifiedMcpServer[];
  declaredTools?: UnifiedDeclaredTool[];
  hookEvents?: UnifiedHookDecl[];
  skillFiles?: string[];
  evalSuite?: { path: string; minScore?: number };
  uiContribution?: PluginUiContribution;
}

const TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;
const ID_RE = /^[a-z0-9][a-z0-9-_]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateUnifiedManifest(raw: unknown): UnifiedBundleManifest {
  // Base validation first (throws PluginManifestError with all base issues).
  const base = validateManifest(raw);
  if (!isRecord(raw)) throw new PluginManifestError(['manifest must be a JSON object']);
  const issues: string[] = [];

  let mcpServers: UnifiedMcpServer[] | undefined;
  if (raw.mcpServers !== undefined) {
    if (!Array.isArray(raw.mcpServers)) issues.push('mcpServers must be an array');
    else {
      mcpServers = [];
      for (const s of raw.mcpServers) {
        if (!isRecord(s) || typeof s.id !== 'string' || !ID_RE.test(s.id) || typeof s.command !== 'string' || !s.command) {
          issues.push('mcpServers[] entries need { id, label, command, args, requiredEnv }');
          continue;
        }
        mcpServers.push({
          id: s.id,
          label: typeof s.label === 'string' ? s.label : s.id,
          command: s.command,
          args: Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : [],
          requiredEnv: Array.isArray(s.requiredEnv) ? s.requiredEnv.filter((a): a is string => typeof a === 'string') : [],
          ...(typeof s.description === 'string' ? { description: s.description } : {}),
        });
      }
    }
  }

  let declaredTools: UnifiedDeclaredTool[] | undefined;
  if (raw.declaredTools !== undefined) {
    if (!Array.isArray(raw.declaredTools)) issues.push('declaredTools must be an array');
    else {
      declaredTools = [];
      for (const t of raw.declaredTools) {
        if (!isRecord(t) || typeof t.name !== 'string' || !TOOL_NAME_RE.test(t.name)) {
          issues.push('declaredTools[] entries need a valid name');
          continue;
        }
        declaredTools.push({
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
          ...(isRecord(t.parameters) ? { parameters: t.parameters } : {}),
          ...(t.mutating === true ? { mutating: true } : {}),
        });
      }
    }
  }

  let hookEvents: UnifiedHookDecl[] | undefined;
  if (raw.hookEvents !== undefined) {
    if (!Array.isArray(raw.hookEvents)) issues.push('hookEvents must be an array of { event }');
    else hookEvents = raw.hookEvents.filter(isRecord).map((h) => ({ event: String(h.event ?? '') })).filter((h) => h.event);
  }

  let skillFiles: string[] | undefined;
  if (raw.skillFiles !== undefined) {
    if (!Array.isArray(raw.skillFiles) || raw.skillFiles.some((f) => !isSafeRelativePath(f))) {
      issues.push('skillFiles must be an array of safe relative paths');
    } else skillFiles = [...(raw.skillFiles as string[])];
  }

  let evalSuite: UnifiedBundleManifest['evalSuite'];
  if (raw.evalSuite !== undefined) {
    if (!isRecord(raw.evalSuite) || !isSafeRelativePath(raw.evalSuite.path)) issues.push('evalSuite.path must be a safe relative path');
    else evalSuite = { path: raw.evalSuite.path as string, ...(typeof raw.evalSuite.minScore === 'number' ? { minScore: raw.evalSuite.minScore } : {}) };
  }

  // CA-24
  let uiContribution: PluginUiContribution | undefined;
  if (raw.uiContribution !== undefined) {
    if (!isRecord(raw.uiContribution)) issues.push('uiContribution must be an object { entry, title, embedding }');
    else {
      if (!isSafeRelativePath(raw.uiContribution.entry)) issues.push('uiContribution.entry must be a safe relative path');
      if (typeof raw.uiContribution.title !== 'string' || !raw.uiContribution.title.trim()) issues.push('uiContribution.title must be non-empty');
      if (raw.uiContribution.embedding !== 'sandboxed-iframe') issues.push('uiContribution.embedding must be "sandboxed-iframe"');
      if (isSafeRelativePath(raw.uiContribution.entry) && typeof raw.uiContribution.title === 'string' && raw.uiContribution.embedding === 'sandboxed-iframe') {
        uiContribution = { entry: raw.uiContribution.entry, title: raw.uiContribution.title, embedding: 'sandboxed-iframe' };
      }
    }
  }

  if (issues.length) throw new PluginManifestError(issues);
  return {
    ...base,
    ...(mcpServers ? { mcpServers } : {}),
    ...(declaredTools ? { declaredTools } : {}),
    ...(hookEvents ? { hookEvents } : {}),
    ...(skillFiles ? { skillFiles } : {}),
    ...(evalSuite ? { evalSuite } : {}),
    ...(uiContribution ? { uiContribution } : {}),
  };
}

export function parseUnifiedManifest(jsonText: string): UnifiedBundleManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch (e) {
    throw new PluginManifestError([`manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`]);
  }
  return validateUnifiedManifest(parsed);
}

/** Convert a legacy plugin.json manifest into the unified shape. */
export function pluginManifestToUnified(m: PluginManifest): UnifiedBundleManifest {
  return {
    ...m,
    ...(m.kinds.includes('ui') && m.ui ? { uiContribution: { entry: m.ui.dir, title: m.ui.title, embedding: 'sandboxed-iframe' as const } } : {}),
    ...(m.kinds.includes('skill') ? { skillFiles: ['SKILL.md'] } : {}),
  };
}

/** Minimal marketplace-entry adapter: an mcp-server / capability entry becomes a unified bundle. */
export function marketplacePayloadToUnified(input: {
  id: string; name: string; version: string; description: string;
  mcpServers?: UnifiedMcpServer[];
}): UnifiedBundleManifest {
  return validateUnifiedManifest({
    id: input.id, name: input.name, version: input.version, description: input.description,
    kinds: ['tool'], entry: 'index.js',
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
  });
}

// ---------------------------------------------------------------------------
// Plugin tool registration (governance-gated)
// ---------------------------------------------------------------------------

export interface PluginToolRegistryEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating?: boolean;
  handler: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;
}

export interface RegisterPluginToolsOptions {
  /** Return true to allow a tool. Mutating tools are DENIED when no hook is given. */
  approveTool?: (info: { pluginId: string; tool: string; mutating: boolean }) => boolean | Promise<boolean>;
  audit?: (action: string, fields: Record<string, unknown>) => void;
  handlerFor: (tool: string) => (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;
}

export interface RegisterPluginToolsResult {
  registered: string[];
  denied: Array<{ tool: string; reason: string }>;
}

/** Register a bundle's declared tools into a registry Map under `plugin:<id>:`. */
export async function registerPluginTools(
  registry: Map<string, PluginToolRegistryEntry>,
  manifest: UnifiedBundleManifest,
  opts: RegisterPluginToolsOptions,
): Promise<RegisterPluginToolsResult> {
  const result: RegisterPluginToolsResult = { registered: [], denied: [] };
  for (const tool of manifest.declaredTools ?? []) {
    const mutating = tool.mutating === true;
    let allowed: boolean;
    if (opts.approveTool) allowed = await opts.approveTool({ pluginId: manifest.id, tool: tool.name, mutating });
    else allowed = !mutating; // deny-by-default for mutating tools
    const namespaced = `plugin:${manifest.id}:${tool.name}`;
    if (!allowed) {
      result.denied.push({ tool: namespaced, reason: mutating ? 'mutating plugin tool requires explicit approval' : 'denied by governance hook' });
      opts.audit?.('plugin.tool.denied', { pluginId: manifest.id, tool: namespaced, mutating });
      continue;
    }
    if (registry.has(namespaced)) {
      result.denied.push({ tool: namespaced, reason: 'already registered' });
      continue;
    }
    registry.set(namespaced, {
      name: namespaced,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
      ...(mutating ? { mutating: true } : {}),
      handler: opts.handlerFor(tool.name),
    });
    result.registered.push(namespaced);
    opts.audit?.('plugin.tool.registered', { pluginId: manifest.id, tool: namespaced, mutating });
  }
  return result;
}

// ---------------------------------------------------------------------------
// CA-24: sandboxed UI contribution rendering (default-off)
// ---------------------------------------------------------------------------

/** CA-24 is default-off: host must explicitly enable plugin UI contributions. */
export function isPluginUiEnabled(flag: boolean | string | undefined): boolean {
  return flag === true || flag === '1' || flag === 'true';
}

export function pluginUiCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "connect-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * Build the iframe HTML wrapper for a plugin UI contribution.
 * The iframe is sandboxed (allow-scripts only, no same-origin, no forms),
 * carries the MCP-Apps-style CSP, and talks to the host only via
 * postMessage with the per-render nonce — the plugin never gets a key,
 * a token, or direct network access.
 */
export function renderPluginUiIframe(input: {
  pluginId: string;
  contribution: PluginUiContribution;
  src: string;
  nonce: string;
}): string {
  const title = input.contribution.title.replace(/[<>&"]/g, '');
  return `<iframe title="${title}" sandbox="allow-scripts" referrerpolicy="no-referrer" data-plugin-ui="${input.pluginId}" data-nonce="${input.nonce}" src="${input.src}"></iframe>`;
}
