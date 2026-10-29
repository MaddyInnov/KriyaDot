// SPDX-License-Identifier: Apache-2.0
/**
 * Local project tools (Octomind parity).
 *
 * A bot workspace can carry executable tools in `.kriyadot/tools/`.
 * Each executable file that declares itself with a `@tool` header
 * comment is auto-registered as a tool named `local:<name>`:
 *
 *   #!/usr/bin/env node
 *   // @tool
 *   // name: lint-fix
 *   // description: Run the project linter with autofix on a path
 *   // parameters: {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}
 *   // mutating: true
 *   // timeoutMs: 60000
 *
 * (`#` for shell/Python and `--` comment prefixes work too.) Invocation
 * contract: the
 * tool receives the call arguments as JSON on stdin and must print a
 * JSON result (or plain text) on stdout; a non-zero exit is an error
 * result with the stderr excerpt. Discovery is cached per directory on
 * an mtime/size signature; broken declarations are reported in
 * `errors` and skipped — never thrown.
 */

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from './types.js';

const HEADER_READ_BYTES = 8_192;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 20_000;

export interface LocalToolsDiscovery {
  tools: ToolDefinition[];
  errors: string[];
}

interface DeclaredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating: boolean;
  timeoutMs: number;
  file: string;
}

const cache = new Map<string, { signature: string; result: LocalToolsDiscovery }>();

function dirSignature(dir: string): string {
  try {
    return readdirSync(dir)
      .sort()
      .map((name) => {
        try {
          const s = statSync(join(dir, name));
          return `${name}:${s.mtimeMs}:${s.size}:${s.mode}`;
        } catch {
          return `${name}:-`;
        }
      })
      .join('|');
  } catch {
    return '-';
  }
}

function parseDeclaration(
  file: string,
  head: string,
): { decl: DeclaredTool } | { error: string } | null {
  const lines = head.split('\n');
  let inBlock = false;
  const fields = new Map<string, string>();
  for (const raw of lines) {
    const line = raw.replace(/^\s*(#|\/\/|--)\s?/, '');
    if (!inBlock) {
      if (line.trim() === '@tool') inBlock = true;
      continue;
    }
    const m = /^([a-zA-Z]+):\s*(.*)$/.exec(line.trim());
    if (!m) break;
    fields.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  if (!inBlock) return null;
  const fileBase = file.split('/').pop()!.replace(/\.[^.]+$/, '');
  const name = (fields.get('name') ?? fileBase).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  let parameters: Record<string, unknown> = { type: 'object', properties: {} };
  const rawParams = fields.get('parameters');
  if (rawParams) {
    try {
      const parsed = JSON.parse(rawParams) as Record<string, unknown>;
      if (typeof parsed === 'object' && parsed !== null) parameters = parsed;
    } catch {
      return { error: 'invalid "parameters" JSON in @tool header' };
    }
  }
  const timeoutRaw = Number(fields.get('timeoutms') ?? '');
  return {
    decl: {
      name,
      description: fields.get('description') ?? `Local project tool ${name}`,
      parameters,
      mutating: fields.get('mutating') === 'true',
      timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : DEFAULT_TIMEOUT_MS,
      file,
    },
  };
}

function makeHandler(decl: DeclaredTool, workspaceDir: string): ToolDefinition['handler'] {
  return async (args) => {
    const stdout = await new Promise<{ out: string; err: string; code: number }>((resolve) => {
      const child = execFile(
        decl.file,
        [],
        { cwd: workspaceDir, timeout: decl.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, out, errOut) => {
          resolve({
            out: String(out ?? ''),
            err: String(errOut ?? ''),
            code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0,
          });
        },
      );
      child.stdin?.end(JSON.stringify(args ?? {}));
    });
    if (stdout.code !== 0) {
      return {
        error:
          `local tool ${decl.name} exited ${stdout.code}: ` +
          (stdout.err || stdout.out).slice(0, 1_000),
      };
    }
    const text = stdout.out.trim().slice(0, MAX_OUTPUT_CHARS);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { output: text };
    }
  };
}

/** Discover local tools in `<workspaceDir>/.kriyadot/tools/`. Never throws. */
export function discoverLocalTools(workspaceDir: string): LocalToolsDiscovery {
  const toolsDir = join(workspaceDir, '.kriyadot', 'tools');
  const signature = dirSignature(toolsDir);
  const cached = cache.get(toolsDir);
  if (cached && cached.signature === signature) return cached.result;

  const errors: string[] = [];
  const tools: ToolDefinition[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(toolsDir).sort();
  } catch {
    const empty: LocalToolsDiscovery = { tools: [], errors: [] };
    cache.set(toolsDir, { signature, result: empty });
    return empty;
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const file = join(toolsDir, entry);
    let head: string;
    let executable = false;
    try {
      const s = statSync(file);
      if (!s.isFile()) continue;
      executable = (s.mode & 0o111) !== 0;
      head = readFileSync(file, 'utf8').slice(0, HEADER_READ_BYTES);
    } catch {
      continue;
    }
    if (!head.includes('@tool')) continue;
    if (!executable) {
      errors.push(`${entry}: declares @tool but is not executable — skipped (chmod +x)`);
      continue;
    }
    const parsed = parseDeclaration(file, head);
    if (!parsed) continue;
    if ('error' in parsed) {
      errors.push(`${entry}: ${parsed.error} — skipped`);
      continue;
    }
    const decl = parsed.decl;
    if (seen.has(decl.name)) {
      errors.push(`${entry}: duplicate local tool name "${decl.name}" — skipped`);
      continue;
    }
    seen.add(decl.name);
    tools.push({
      name: `local:${decl.name}`,
      description: decl.description,
      parameters: decl.parameters,
      mutating: decl.mutating,
      handler: makeHandler(decl, workspaceDir),
    });
  }
  const result: LocalToolsDiscovery = { tools, errors };
  cache.set(toolsDir, { signature, result });
  return result;
}

/** Test hook. */
export function clearLocalToolsCache(): void {
  cache.clear();
}
