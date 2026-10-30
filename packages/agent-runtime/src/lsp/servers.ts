// SPDX-License-Identifier: Apache-2.0
// Language-server registry (CA-9): the built-in fleet — TypeScript/
// JavaScript, Python (pyright, with python-lsp-server as fallback), Go
// (gopls) and Rust (rust-analyzer) — plus a config-extensible registry:
// hosts register additional definitions via LspManager options or
// `registerLanguageServer`, and a workspace may add servers through
// `.kriyadot/lsp.json`:
//   { "servers": [ { "id": "ruby", "extensions": [".rb"],
//                    "command": "solargraph", "args": ["stdio"] } ] }
//
// Launch model per definition:
//   - `command`/`args`: the direct binary launch (PATH lookup).
//   - `npxPackage` (optional): when the binary is missing AND auto-install
//     is enabled, launch through `npx -y --package=<pkg> <bin>` — the
//     ecosystem's standard fetch-on-demand path for TS/Python servers.
//   - `installCommand` (optional): when auto-install is enabled, run this
//     once (e.g. `pip install python-lsp-server`, `go install …gopls`)
//     and retry the direct launch.

import { extname } from 'node:path';

export interface LanguageServerDefinition {
  id: string;
  /** File extensions this server owns, lowercase with dot ('.ts'). */
  extensions: string[];
  /** Direct launch command. */
  command: string;
  args: string[];
  /** Binary name when launched via npx (defaults to `command`). */
  npxBin?: string;
  /** npm package fetched via `npx -y --package=<pkg>` as a fallback launch. */
  npxPackage?: string;
  /** One-time install command attempted (auto-install only) before retry. */
  installCommand?: { command: string; args: string[] };
}

/** LSP languageId for a file path (fleet-wide mapping). */
export function languageIdForPath(absPath: string): string {
  const ext = extname(absPath).toLowerCase();
  switch (ext) {
    case '.ts': return 'typescript';
    case '.tsx': return 'typescriptreact';
    case '.js':
    case '.mjs':
    case '.cjs': return 'javascript';
    case '.jsx': return 'javascriptreact';
    case '.py': return 'python';
    case '.go': return 'go';
    case '.rs': return 'rust';
    case '.json': return 'json';
    case '.md': return 'markdown';
    default: return 'plaintext';
  }
}

export const BUILTIN_LANGUAGE_SERVERS: LanguageServerDefinition[] = [
  {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    npxPackage: 'typescript-language-server',
  },
  {
    id: 'pyright',
    extensions: ['.py'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    npxPackage: 'pyright',
    npxBin: 'pyright-langserver',
  },
  {
    id: 'python-lsp',
    extensions: ['.py'],
    command: 'pylsp',
    args: [],
    installCommand: { command: 'pip', args: ['install', 'python-lsp-server'] },
  },
  {
    id: 'gopls',
    extensions: ['.go'],
    command: 'gopls',
    args: ['serve'],
    installCommand: { command: 'go', args: ['install', 'golang.org/x/tools/gopls@latest'] },
  },
  {
    id: 'rust-analyzer',
    extensions: ['.rs'],
    command: 'rust-analyzer',
    args: [],
    installCommand: { command: 'rustup', args: ['component', 'add', 'rust-analyzer'] },
  },
];

const extraServers: LanguageServerDefinition[] = [];

/**
 * Register an additional language server process-wide (host extension
 * point). Later registrations with the same id replace earlier ones.
 * Definitions registered here are tried AFTER the built-ins for a given
 * extension, in registration order.
 */
export function registerLanguageServer(def: LanguageServerDefinition): void {
  const idx = extraServers.findIndex((s) => s.id === def.id);
  if (idx >= 0) extraServers.splice(idx, 1, def);
  else extraServers.push(def);
}

/** All registered extra servers (snapshot). */
export function registeredLanguageServers(): LanguageServerDefinition[] {
  return [...extraServers];
}

/** Test hook: forget all extra registrations. */
export function clearRegisteredLanguageServers(): void {
  extraServers.length = 0;
}

/**
 * Definitions that can serve `absPath`, in try order: built-ins first,
 * then manager-supplied extras, then process-wide registrations, then
 * workspace `.kriyadot/lsp.json` entries (passed in by the manager).
 */
export function serversForFile(
  absPath: string,
  extras: LanguageServerDefinition[] = [],
): LanguageServerDefinition[] {
  const ext = extname(absPath).toLowerCase();
  const all = [...BUILTIN_LANGUAGE_SERVERS, ...extras, ...extraServers];
  const seen = new Set<string>();
  const out: LanguageServerDefinition[] = [];
  for (const def of all) {
    if (seen.has(def.id)) continue;
    if (def.extensions.map((e) => e.toLowerCase()).includes(ext)) {
      seen.add(def.id);
      out.push(def);
    }
  }
  return out;
}

/** Validate a server definition loaded from a workspace config file. */
export function parseServerDefinition(raw: unknown): LanguageServerDefinition | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.command !== 'string' || !r.command) return null;
  if (!Array.isArray(r.extensions) || r.extensions.some((e) => typeof e !== 'string')) return null;
  const args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : [];
  return {
    id: r.id,
    extensions: (r.extensions as string[]).map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)),
    command: r.command,
    args,
    ...(typeof r.npxPackage === 'string' ? { npxPackage: r.npxPackage } : {}),
    ...(typeof r.npxBin === 'string' ? { npxBin: r.npxBin } : {}),
  };
}
