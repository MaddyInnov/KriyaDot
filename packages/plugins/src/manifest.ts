// SPDX-License-Identifier: Apache-2.0
// Plugin manifest (plugin.json) types + validation.
//
// A KriyaDot plugin is a directory with a plugin.json at its root:
//
//   {
//     "id": "demo-toolkit",
//     "name": "Demo Toolkit",
//     "version": "1.0.0",
//     "description": "Example tools",
//     "kinds": ["tool"],
//     "entry": "index.js",              // required for executable kinds
//     "permissions": { "network": false, "env": ["SOME_TOKEN"] },
//     "ui": { "dir": "public", "title": "Panel" }  // required for kind "ui"
//   }
//
// Kinds:
//   - tool:    executable; speaks tools/list + tools/call over stdio JSON-RPC.
//   - hook:    executable; speaks hooks/invoke, returns HookBus-compatible
//              results ({ cancel } | { inject } | { transform } | nothing).
//   - channel: executable; speaks channel/send + channel/poll and bridges to
//              a messaging-provider-shaped interface.
//   - skill:   non-executable; the directory carries a SKILL.md that is
//              registered into the skill-store shape.
//   - ui:      non-executable; a static asset directory served by the API
//              under sandboxed headers.
//
// Validation is pure (no filesystem): the manager additionally checks that
// referenced files (entry, ui dir, SKILL.md) actually exist on disk.

export const PLUGIN_KINDS = ['tool', 'skill', 'hook', 'ui', 'channel'] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/** Kinds whose plugin runs code (stdio JSON-RPC child process). */
export const EXECUTABLE_KINDS: readonly PluginKind[] = ['tool', 'hook', 'channel'];

export interface PluginPermissions {
  /** Declared network access. Declarative: recorded and surfaced to the
   *  approval flow / UI. The stdio sandbox does not itself block sockets
   *  (no portable way without an OS sandbox); hosts that need hard
   *  isolation should run plugins under their sandbox backend. */
  network?: boolean;
  /** Names of host environment variables the plugin process may see.
   *  Everything else is scrubbed from the child environment. */
  env?: string[];
}

export interface PluginUiSpec {
  /** Static asset directory, relative to the plugin root. */
  dir: string;
  /** Panel title shown in the host UI. */
  title: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  kinds: PluginKind[];
  /** Entry file for executable kinds, relative to the plugin root. */
  entry?: string;
  permissions?: PluginPermissions;
  ui?: PluginUiSpec;
}

export class PluginManifestError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid plugin manifest: ${issues.join('; ')}`);
    this.name = 'PluginManifestError';
    this.issues = issues;
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-_]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True for a safe plugin-relative path: relative, no `..`, no backslashes. */
export function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(p)) return false; // windows drive
  if (p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '..' && seg !== '');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate an unknown value as a PluginManifest. Returns a normalized copy
 * (permissions defaulted) or throws PluginManifestError listing EVERY issue.
 */
export function validateManifest(raw: unknown): PluginManifest {
  const issues: string[] = [];
  if (!isRecord(raw)) {
    throw new PluginManifestError(['manifest must be a JSON object']);
  }

  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || raw.id.length > 64) {
    issues.push('id must match /^[a-z0-9][a-z0-9-_]*$/ and be at most 64 chars');
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 120) {
    issues.push('name must be a non-empty string of at most 120 chars');
  }
  if (typeof raw.version !== 'string' || !VERSION_RE.test(raw.version)) {
    issues.push('version must be semver (e.g. "1.0.0")');
  }
  if (typeof raw.description !== 'string' || raw.description.trim().length === 0 || raw.description.length > 1000) {
    issues.push('description must be a non-empty string of at most 1000 chars');
  }

  let kinds: PluginKind[] = [];
  if (!Array.isArray(raw.kinds) || raw.kinds.length === 0) {
    issues.push(`kinds must be a non-empty array drawn from: ${PLUGIN_KINDS.join(', ')}`);
  } else {
    const seen = new Set<string>();
    for (const k of raw.kinds) {
      if (typeof k !== 'string' || !(PLUGIN_KINDS as readonly string[]).includes(k)) {
        issues.push(`kinds contains unknown kind ${JSON.stringify(k)} (allowed: ${PLUGIN_KINDS.join(', ')})`);
      } else if (seen.has(k)) {
        issues.push(`kinds contains duplicate kind "${k}"`);
      } else {
        seen.add(k);
        kinds.push(k as PluginKind);
      }
    }
  }

  const executable = kinds.some((k) => EXECUTABLE_KINDS.includes(k));
  if (raw.entry !== undefined && !isSafeRelativePath(raw.entry)) {
    issues.push('entry must be a safe relative path (no absolute paths, no "..", no backslashes)');
  }
  if (executable && raw.entry === undefined) {
    issues.push(`entry is required for executable kinds (${EXECUTABLE_KINDS.join(', ')})`);
  }

  let permissions: PluginPermissions | undefined;
  if (raw.permissions !== undefined) {
    if (!isRecord(raw.permissions)) {
      issues.push('permissions must be an object { network?: boolean, env?: string[] }');
    } else {
      permissions = {};
      if (raw.permissions.network !== undefined) {
        if (typeof raw.permissions.network !== 'boolean') issues.push('permissions.network must be a boolean');
        else permissions.network = raw.permissions.network;
      }
      if (raw.permissions.env !== undefined) {
        if (!Array.isArray(raw.permissions.env) || raw.permissions.env.some((e) => typeof e !== 'string' || !ENV_NAME_RE.test(e))) {
          issues.push('permissions.env must be an array of environment variable names (e.g. ["MY_TOKEN"])');
        } else {
          permissions.env = [...(raw.permissions.env as string[])];
        }
      }
    }
  }

  let ui: PluginUiSpec | undefined;
  if (raw.ui !== undefined) {
    if (!isRecord(raw.ui)) {
      issues.push('ui must be an object { dir, title }');
    } else {
      if (!isSafeRelativePath(raw.ui.dir)) issues.push('ui.dir must be a safe relative path');
      if (typeof raw.ui.title !== 'string' || raw.ui.title.trim().length === 0) issues.push('ui.title must be a non-empty string');
      if (isSafeRelativePath(raw.ui.dir) && typeof raw.ui.title === 'string') {
        ui = { dir: raw.ui.dir, title: raw.ui.title };
      }
    }
  }
  if (kinds.includes('ui') && raw.ui === undefined) {
    issues.push('ui { dir, title } is required for kind "ui"');
  }

  if (issues.length > 0) throw new PluginManifestError(issues);
  return {
    id: raw.id as string,
    name: raw.name as string,
    version: raw.version as string,
    description: raw.description as string,
    kinds,
    ...(typeof raw.entry === 'string' ? { entry: raw.entry } : {}),
    ...(permissions ? { permissions } : {}),
    ...(ui ? { ui } : {}),
  };
}

/** Parse + validate plugin.json text. Syntax errors become PluginManifestError. */
export function parseManifest(jsonText: string): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new PluginManifestError([`plugin.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return validateManifest(parsed);
}
