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
 *
 * Security model (#117c / #126 — the runtime half; the user-facing
 * documentation and the default-policy `local:` rule are a separate
 * workstream):
 *   - CONFINEMENT: local tools execute under the same kernel
 *     confinement as `run_command` BY DEFAULT — Landlock on Linux /
 *     Seatbelt on macOS, with the bot workspace as the writable root.
 *     When the kernel backend is unavailable the tool runs on the host
 *     with a loud warning (console + `__sandbox` metadata on object
 *     results), mirroring the sandbox fallback — UNLESS strict mode
 *     (SANDBOX_STRICT=1) is configured, in which case the call fails
 *     closed. Explicit opt-out: SANDBOX_ALLOW_HOST=1 or
 *     SANDBOX_DISABLE_KERNEL=1 runs on the host deliberately.
 *   - MUTATING IS FAIL-CLOSED: the `mutating` header is governance-
 *     visible metadata, and it is NOT self-declared trust anymore. A
 *     tool that does not explicitly declare `mutating:` is treated as
 *     mutating=true (plan-mode gate + approval policy apply). Only an
 *     explicit `mutating: false` marks a local tool read-only.
 */

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from './types.js';
import { probeKernelBackend, runArgvConfined } from './tools/sandbox-kernel.js';

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
  /**
   * Effective mutating flag carried by the ToolDefinition (#126):
   * true unless the header EXPLICITLY declares `mutating: false`.
   */
  mutating: boolean;
  /** True when the header declared `mutating:` at all. */
  mutatingDeclared: boolean;
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
  // #126 fail-closed: only an explicit `mutating: false` is read-only.
  // An undeclared flag (or any other value) is treated as mutating —
  // the header is metadata for governance, not self-granted trust.
  const mutatingDeclared = fields.has('mutating');
  const mutating = !(fields.get('mutating') === 'false');
  return {
    decl: {
      name,
      description: fields.get('description') ?? `Local project tool ${name}`,
      parameters,
      mutating,
      mutatingDeclared,
      timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : DEFAULT_TIMEOUT_MS,
      file,
    },
  };
}

/** Kernel confinement opt-out / strict knobs — same env contract as tools/sandbox.ts (#117). */
function localToolHostOptedOut(): boolean {
  return process.env.SANDBOX_ALLOW_HOST === '1' || process.env.SANDBOX_DISABLE_KERNEL === '1';
}
function localToolStrict(): boolean {
  return process.env.SANDBOX_STRICT === '1';
}

interface LocalRun {
  out: string;
  err: string;
  code: number;
  /** Set when the run was NOT kernel-confined (host fallback/opt-out). */
  sandboxWarning?: string;
}

/** Execute the tool file once, kernel-confined by default (#117c). */
async function runLocalTool(decl: DeclaredTool, workspaceDir: string, stdinJson: string): Promise<LocalRun> {
  if (!localToolHostOptedOut() && (await probeKernelBackend()) !== null) {
    const res = await runArgvConfined([decl.file], {
      workspaceDir,
      timeoutMs: decl.timeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
      stdin: stdinJson,
    });
    return { out: res.stdout, err: res.stderr, code: res.exitCode };
  }
  if (localToolStrict() && !localToolHostOptedOut()) {
    return {
      out: '',
      err: 'kernel sandbox unavailable and SANDBOX_STRICT=1 (fail-closed)',
      code: 126,
      sandboxWarning: 'local tool refused: no kernel sandbox available in strict mode',
    };
  }
  // Host fallback / explicit opt-out: loud warning, mirroring the
  // run_command fallback — never a silent unsandboxed run.
  const warning =
    'WARNING: local tool executed UNSANDBOXED on the host — no kernel sandbox backend was available (or host execution was explicitly opted into).';
  console.warn(`[local-tools] ${warning} tool=${decl.name}`);
  const res = await new Promise<{ out: string; err: string; code: number }>((resolve) => {
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
    child.stdin?.end(stdinJson);
  });
  return { ...res, sandboxWarning: warning };
}

function makeHandler(decl: DeclaredTool, workspaceDir: string): ToolDefinition['handler'] {
  return async (args) => {
    const stdout = await runLocalTool(decl, workspaceDir, JSON.stringify(args ?? {}));
    if (stdout.code !== 0) {
      return {
        error:
          `local tool ${decl.name} exited ${stdout.code}: ` +
          (stdout.err || stdout.out).slice(0, 1_000),
        ...(stdout.sandboxWarning ? { __sandbox: { sandboxed: false, warning: stdout.sandboxWarning } } : {}),
      };
    }
    const text = stdout.out.trim().slice(0, MAX_OUTPUT_CHARS);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { output: text };
    }
    if (stdout.sandboxWarning && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return {
        ...(parsed as Record<string, unknown>),
        __sandbox: { sandboxed: false, warning: stdout.sandboxWarning },
      };
    }
    return parsed;
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
