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
//     "permissions": { "network": false, "env": ["SOME_TOKEN"],
//                      "fs": { "read": ["/data/shared"], "write": [] } },
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
//   - provider (A9): NON-executable and manifest-only — no code at all. The
//              manifest's `provider` block declares an OpenAI-compatible
//              LLM provider (A2 provider-manifest conventions: id, display
//              name, base URL, env/secret key mapping, live-models flag)
//              that the host serves through its BUILT-IN OpenAI-compatible
//              driver. A provider package stands alone: it cannot be
//              combined with any other kind, and it must not declare an
//              entry point (there is nothing to run).
//
// Declared secrets (`secrets`): NAMES only, never values. A plugin lists
// the secret names it needs; the host resolves values at runtime from its
// own secret store / environment (for executable plugins they are injected
// into the scrubbed child env under the declared name; for provider
// plugins the provider's `apiKeyEnv` name is resolved through the
// provider credential chain). A secret value inside a package is a
// authoring error — packages are distributable artifacts and are signed
// as-is, so anything in them is public to every recipient.
//
// Deliberately NOT in this schema: contributed HTTP routes / webhooks.
// The plugin host has no honest surface for them — executable plugins are
// spawned per invocation with no listener, inbound channel delivery is
// pull-based (channel/poll), and UI assets are served by the host under
// its own routes. Declaring a route the host cannot honour would be a
// lie on the approval surface, so the field does not exist (A9).
//
// Validation is pure (no filesystem): the manager additionally checks that
// referenced files (entry, ui dir, SKILL.md) actually exist on disk.

export const PLUGIN_KINDS = ['tool', 'skill', 'hook', 'ui', 'channel', 'provider'] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/** Kinds whose plugin runs code (stdio JSON-RPC child process). */
export const EXECUTABLE_KINDS: readonly PluginKind[] = ['tool', 'hook', 'channel'];

export interface PluginFsPermissions {
  /** Additional ABSOLUTE paths the plugin child may read (read+execute),
   *  beyond its own directory and the runtime allowlist. Enforced by the
   *  kernel sandbox (plugin-sandbox.ts); surfaced at install approval. */
  read?: string[];
  /** Additional ABSOLUTE paths the plugin child may read AND write,
   *  beyond its own directory. Enforced like `read`. */
  write?: string[];
}

export interface PluginPermissions {
  /** Declared network access. ENFORCED by the kernel sandbox
   *  (plugin-sandbox.ts): anything other than `true` means the child
   *  runs with network access denied (network namespace + Landlock NET
   *  rules on Linux, Seatbelt network denial on macOS). On a host with
   *  no kernel sandbox backend, a plugin that does not declare
   *  `network: true` (plus filesystem access to "/") is REFUSED rather
   *  than run unconfined — see plugin-sandbox.ts fail-closed policy. */
  network?: boolean;
  /** Names of host environment variables the plugin process may see.
   *  Everything else is scrubbed from the child environment. */
  env?: string[];
  /** Additional filesystem grants beyond the plugin's own directory.
   *  The child is otherwise confined to its own directory (read+write)
   *  plus a read-only runtime allowlist. */
  fs?: PluginFsPermissions;
}

export interface PluginUiSpec {
  /** Static asset directory, relative to the plugin root. */
  dir: string;
  /** Panel title shown in the host UI. */
  title: string;
}

/**
 * A9 declarative provider declaration (kind "provider"). Mirrors the
 * catalog preset shape the provider system already speaks (see
 * @mvp/agent-runtime providers/catalog.ts ProviderPreset): the host turns
 * this block into a preset with api "openai-compatible" and serves it
 * through the built-in driver — the package contributes NO driver code.
 */
export interface DeclarativeProviderSpec {
  /** Provider id as it appears in the provider registry / picker. Slug. */
  providerId: string;
  /** Display name shown in the picker (defaults to the plugin name). */
  displayName?: string;
  /**
   * Base URL of an OpenAI-compatible endpoint. The built-in driver calls
   * `<baseUrl>/models` (when liveModels) and `<baseUrl>/chat/completions`.
   * Must be http(s) with NO embedded credentials.
   */
  baseUrl: string;
  /**
   * Name of the env var / stored secret holding the API key. NAMES ONLY —
   * the value is resolved by the host at runtime through the provider
   * credential chain (environment → local provider store), never shipped
   * in the package. Required unless `apiKeyRequired` is false, and must
   * also be listed in the manifest's `secrets` array so the approval
   * surface shows the complete secret footprint.
   */
  apiKeyEnv?: string;
  /** False = keyless endpoint (e.g. a local server): no key is sent. Default true. */
  apiKeyRequired?: boolean;
  /** True (default) = models are fetched live from `<baseUrl>/models`. */
  liveModels?: boolean;
  /** Optional static model roster (A2 "catalog-static" convention), used
   *  as the picker's list when liveModels is false and as a fallback when
   *  a live fetch fails. */
  models?: Array<{ id: string; name?: string; default?: boolean }>;
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
  /** Display name of the publisher (a claim — the cryptographic identity
   *  is the signing key id in the package signature, see package.ts). */
  publisher?: string;
  /** Declared secret NAMES the plugin needs (values never ship in the
   *  package; the host resolves them at runtime). Shown at approval. */
  secrets?: string[];
  /** Declarative provider block; required for kind "provider", forbidden otherwise. */
  provider?: DeclarativeProviderSpec;
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
      issues.push('permissions must be an object { network?: boolean, env?: string[], fs?: { read?: string[], write?: string[] } }');
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
      if (raw.permissions.fs !== undefined) {
        if (!isRecord(raw.permissions.fs)) {
          issues.push('permissions.fs must be an object { read?: string[], write?: string[] }');
        } else {
          // Declared grants are part of the approval surface, so they are
          // kept literal: absolute paths only, no ".." segments (nothing
          // for the sandbox layer to reinterpret), bounded in count/size.
          const validGrantList = (v: unknown): v is string[] =>
            Array.isArray(v) &&
            v.length <= 32 &&
            v.every(
              (p) =>
                typeof p === 'string' &&
                p.length <= 512 &&
                p.startsWith('/') &&
                !p.includes('\\') &&
                p.split('/').every((seg) => seg !== '..'),
            );
          const fs: PluginFsPermissions = {};
          let fsOk = true;
          if (raw.permissions.fs.read !== undefined) {
            if (!validGrantList(raw.permissions.fs.read)) {
              issues.push('permissions.fs.read must be an array of at most 32 absolute paths (no "..", no backslashes)');
              fsOk = false;
            } else fs.read = [...raw.permissions.fs.read];
          }
          if (raw.permissions.fs.write !== undefined) {
            if (!validGrantList(raw.permissions.fs.write)) {
              issues.push('permissions.fs.write must be an array of at most 32 absolute paths (no "..", no backslashes)');
              fsOk = false;
            } else fs.write = [...raw.permissions.fs.write];
          }
          if (fsOk) permissions.fs = fs;
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

  // ---- A9: publisher / secrets / declarative provider ---------------------

  let publisher: string | undefined;
  if (raw.publisher !== undefined) {
    if (typeof raw.publisher !== 'string' || raw.publisher.trim().length === 0 || raw.publisher.length > 120) {
      issues.push('publisher must be a non-empty string of at most 120 chars');
    } else publisher = raw.publisher;
  }

  let secrets: string[] | undefined;
  if (raw.secrets !== undefined) {
    if (
      !Array.isArray(raw.secrets) ||
      raw.secrets.length > 32 ||
      raw.secrets.some((s) => typeof s !== 'string' || !ENV_NAME_RE.test(s))
    ) {
      issues.push('secrets must be an array of at most 32 secret NAMES (env-var shape, e.g. ["MY_API_KEY"]) — names only, never values');
    } else if (new Set(raw.secrets as string[]).size !== (raw.secrets as string[]).length) {
      issues.push('secrets must not contain duplicates');
    } else {
      secrets = [...(raw.secrets as string[])];
    }
  }

  let provider: DeclarativeProviderSpec | undefined;
  const hasProviderKind = kinds.includes('provider');
  if (raw.provider !== undefined && !hasProviderKind) {
    issues.push('provider block is only allowed with kind "provider"');
  }
  if (hasProviderKind) {
    if (kinds.length !== 1) {
      issues.push('kind "provider" must stand alone (a declarative provider package is manifest-only, no code, no other kinds)');
    }
    if (raw.entry !== undefined) {
      issues.push('provider plugins are manifest-only: entry must not be declared');
    }
    if (!isRecord(raw.provider)) {
      issues.push('provider { providerId, baseUrl, apiKeyEnv?, ... } is required for kind "provider"');
    } else {
      const p = raw.provider;
      const spec: DeclarativeProviderSpec = { providerId: '', baseUrl: '' };
      let ok = true;
      if (typeof p.providerId !== 'string' || !ID_RE.test(p.providerId) || p.providerId.length > 64) {
        issues.push('provider.providerId must match /^[a-z0-9][a-z0-9-_]*$/ and be at most 64 chars');
        ok = false;
      } else spec.providerId = p.providerId;
      if (p.displayName !== undefined) {
        if (typeof p.displayName !== 'string' || p.displayName.trim().length === 0 || p.displayName.length > 120) {
          issues.push('provider.displayName must be a non-empty string of at most 120 chars');
          ok = false;
        } else spec.displayName = p.displayName;
      }
      if (typeof p.baseUrl !== 'string' || p.baseUrl.length > 512) {
        issues.push('provider.baseUrl must be an http(s) URL string of at most 512 chars');
        ok = false;
      } else {
        let url: URL | undefined;
        try {
          url = new URL(p.baseUrl);
        } catch {
          issues.push('provider.baseUrl must be a valid http(s) URL');
          ok = false;
        }
        if (url) {
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            issues.push('provider.baseUrl must use http: or https:');
            ok = false;
          }
          if (url.username || url.password) {
            issues.push('provider.baseUrl must not embed credentials (declare the key via apiKeyEnv instead)');
            ok = false;
          }
          if (url.search || url.hash) {
            issues.push('provider.baseUrl must not carry a query string or fragment');
            ok = false;
          }
        }
        spec.baseUrl = p.baseUrl.replace(/\/+$/, '');
      }
      const keyRequired = p.apiKeyRequired !== false;
      if (p.apiKeyRequired !== undefined && typeof p.apiKeyRequired !== 'boolean') {
        issues.push('provider.apiKeyRequired must be a boolean');
        ok = false;
      }
      if (p.apiKeyEnv !== undefined) {
        if (typeof p.apiKeyEnv !== 'string' || !ENV_NAME_RE.test(p.apiKeyEnv)) {
          issues.push('provider.apiKeyEnv must be an env-var-shaped NAME (e.g. "MY_API_KEY")');
          ok = false;
        } else spec.apiKeyEnv = p.apiKeyEnv;
      }
      if (keyRequired && p.apiKeyEnv === undefined) {
        issues.push('provider.apiKeyEnv is required unless provider.apiKeyRequired is false (the key NAME is declared; its value never ships in the package)');
        ok = false;
      }
      if (spec.apiKeyEnv && !(secrets ?? []).includes(spec.apiKeyEnv)) {
        issues.push(`provider.apiKeyEnv "${spec.apiKeyEnv}" must also be listed in secrets[] so the approval surface shows the full secret footprint`);
        ok = false;
      }
      if (p.liveModels !== undefined) {
        if (typeof p.liveModels !== 'boolean') {
          issues.push('provider.liveModels must be a boolean');
          ok = false;
        } else spec.liveModels = p.liveModels;
      }
      if (p.models !== undefined) {
        if (!Array.isArray(p.models) || p.models.length > 200) {
          issues.push('provider.models must be an array of at most 200 { id, name?, default? } entries');
          ok = false;
        } else {
          const models: NonNullable<DeclarativeProviderSpec['models']> = [];
          const seenIds = new Set<string>();
          for (const m of p.models as Array<Record<string, unknown>>) {
            if (!isRecord(m) || typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 200) {
              issues.push('provider.models[] entries need a non-empty string id of at most 200 chars');
              ok = false;
              continue;
            }
            if (seenIds.has(m.id)) {
              issues.push(`provider.models contains duplicate id "${m.id}"`);
              ok = false;
              continue;
            }
            seenIds.add(m.id);
            models.push({
              id: m.id,
              ...(typeof m.name === 'string' && m.name.length > 0 ? { name: m.name } : {}),
              ...(m.default === true ? { default: true } : {}),
            });
          }
          if (models.length > 0) spec.models = models;
        }
      }
      if (ok) {
        if (p.apiKeyRequired === false) spec.apiKeyRequired = false;
        provider = spec;
      }
    }
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
    ...(publisher ? { publisher } : {}),
    ...(secrets ? { secrets } : {}),
    ...(provider ? { provider } : {}),
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
