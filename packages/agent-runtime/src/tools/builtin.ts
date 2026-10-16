// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ToolContext, ToolDefinition } from '../types.js';
import { executeInPersistentSandbox, executeSandboxedCommand, sandboxBackend } from './sandbox.js';
import { resolveWorkspaceDir, type WorkspaceSource } from '../workspaces.js';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 8 * 1024; // 8KB truncation for command output
const MAX_FETCH_BYTES = 200 * 1024; // 200KB cap for web_fetch
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Refuse obviously destructive shell patterns before they run.
 *
 * This is the tool-level hard floor (defense in depth alongside the
 * governance gateway): catastrophic commands are refused UNCONDITIONALLY —
 * a human approval can never lift this. Merely destructive-but-recoverable
 * commands (deleting a specific project file, etc.) are not denylisted here;
 * they go through the governance approval path instead.
 */
const COMMAND_DENYLIST: RegExp[] = [
  /rm\s+-rf\s+\//, // rm -rf /
  /mkfs/, // filesystem formatting
  /\bdd\b[^;&|]*\bof=\s*\/dev\//, // dd writing to a raw block device
  /\b(shred|wipefs|fdisk|sfdisk|gdisk|sgdisk|cgdisk|parted)\b/, // disk wipe/partition tools
  /:\(\)\s*\{/, // fork bombs
];

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
  return buf.toString('utf8') + `\n…[truncated to ${maxBytes} bytes]`;
}

/**
 * Resolve `p` inside `workspaceDir`. Throws if the resolved path escapes the
 * workspace (directory traversal).
 */
function confine(workspaceDir: string, p: string): string {
  const root = resolve(workspaceDir);
  const resolved = resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Path escapes workspace: "${p}"`);
  }
  return resolved;
}

function readFileTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the workspace. Path is relative to the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative file path' } },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const file = confine(resolveWorkspaceDir(workspaceDir, ctx), String(args.path));
      return readFileSync(file, 'utf8');
    },
  };
}

function writeFileTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'write_file',
    mutating: true,
    description: 'Write (or overwrite) a UTF-8 text file inside the workspace. Parent directories are created.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const file = confine(resolveWorkspaceDir(workspaceDir, ctx), String(args.path));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, String(args.content), 'utf8');
      return { written: file, bytes: Buffer.byteLength(String(args.content), 'utf8') };
    },
  };
}

function runCommandTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'run_command',
    mutating: true,
    description:
      'Run a shell command (sh -c). Destructive patterns are refused. ' +
      'Executes inside an E2B cloud sandbox when E2B_API_KEY is set, else a local Docker container ' +
      '(isolated: no workspace files, no network by default); ' +
      'falls back to host execution with the workspace as cwd only when no sandbox backend is available ' +
      '(result carries sandboxed:false). ' +
      'Stdout/stderr are truncated to 8KB.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 30000)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const command = String(args.command);
      for (const pattern of COMMAND_DENYLIST) {
        if (pattern.test(command)) {
          throw new Error(`Refused by command denylist (${pattern.source}): "${command.slice(0, 120)}"`);
        }
      }
      const timeoutMs =
        typeof args.timeoutMs === 'number' && args.timeoutMs > 0
          ? Math.min(args.timeoutMs, 120_000)
          : DEFAULT_COMMAND_TIMEOUT_MS;
      // Persistent Dot environment: run inside the Dot's own long-lived E2B
      // sandbox instead of a fresh ephemeral one. Falls back to ephemeral on
      // connect failure (the sandbox may have expired).
      const persistentId = ctx?.persistentSandboxId;
      if (persistentId && sandboxBackend() === 'e2b') {
        try {
          const result = await executeInPersistentSandbox(persistentId, command, {
            timeoutMs,
            maxOutputBytes: MAX_OUTPUT_BYTES * 4,
          });
          return {
            exitCode: result.exitCode,
            timedOut: result.timedOut ?? false,
            stdout: truncate(result.stdout, MAX_OUTPUT_BYTES),
            stderr: truncate(result.stderr, MAX_OUTPUT_BYTES),
            sandboxed: true,
            backend: 'e2b-persistent',
          };
        } catch (err) {
          // Persistent sandbox gone (expired/killed) — fall through to
          // ephemeral rather than failing the turn.
          console.warn(`[run_command] persistent sandbox ${persistentId} unreachable, using ephemeral: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Phase 3: prefer the sandboxed backend (E2B cloud, else Docker).
      // Host execution remains only as a last resort so the tool keeps
      // working on machines with neither; the result is flagged.
      if (sandboxBackend() !== 'none') {
        const result = await executeSandboxedCommand(command, {
          timeoutMs,
          maxOutputBytes: MAX_OUTPUT_BYTES * 4,
        });
        return {
          exitCode: result.exitCode,
          timedOut: result.timedOut ?? false,
          stdout: truncate(result.stdout, MAX_OUTPUT_BYTES),
          stderr: truncate(result.stderr, MAX_OUTPUT_BYTES),
          sandboxed: true,
          backend: sandboxBackend(),
        };
      }
      try {
        const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
          cwd: resolveWorkspaceDir(workspaceDir, ctx),
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES * 4,
          windowsHide: true,
        });
        return {
          exitCode: 0,
          stdout: truncate(stdout, MAX_OUTPUT_BYTES),
          stderr: truncate(stderr, MAX_OUTPUT_BYTES),
          sandboxed: false,
        };
      } catch (err) {
        const e = err as {
          stdout?: string;
          stderr?: string;
          code?: number | string;
          killed?: boolean;
          message: string;
        };
        if (e.killed) {
          return {
            exitCode: 124,
            timedOut: true,
            stdout: truncate(e.stdout ?? '', MAX_OUTPUT_BYTES),
            stderr: truncate(e.stderr ?? '', MAX_OUTPUT_BYTES),
            sandboxed: false,
          };
        }
        return {
          exitCode: typeof e.code === 'number' ? e.code : 1,
          stdout: truncate(e.stdout ?? '', MAX_OUTPUT_BYTES),
          stderr: truncate(e.stderr ?? e.message ?? '', MAX_OUTPUT_BYTES),
          sandboxed: false,
        };
      }
    },
  };
}

function webSearchTool(): ToolDefinition {
  return {
    name: 'web_search',
    description: 'Search the web via the DuckDuckGo instant-answer API. Returns the abstract plus top related topics.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args, _ctx: ToolContext) => {
      const url =
        `https://api.duckduckgo.com/?q=${encodeURIComponent(String(args.query))}` +
        `&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);
      const data = (await res.json()) as {
        AbstractText?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };
      return {
        abstract: data.AbstractText ?? '',
        source: data.AbstractURL ?? '',
        topics: (data.RelatedTopics ?? [])
          .filter((t) => t.Text)
          .slice(0, 5)
          .map((t) => ({ text: t.Text, url: t.FirstURL })),
      };
    },
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function webFetchTool(): ToolDefinition {
  return {
    name: 'web_fetch',
    description: 'Fetch a URL and return its text content (HTML stripped, capped at 200KB).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to fetch' } },
      required: ['url'],
      additionalProperties: false,
    },
    handler: async (args, _ctx: ToolContext) => {
      const url = String(args.url);
      if (!/^https?:\/\//i.test(url)) throw new Error(`Only http(s) URLs may be fetched: "${url}"`);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        headers: { 'User-Agent': 'mvp-agent-runtime/0.1.0' },
      });
      if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status} for ${url}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error('Empty response body');
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total >= MAX_FETCH_BYTES) break;
      }
      const html = Buffer.concat(chunks).subarray(0, MAX_FETCH_BYTES).toString('utf8');
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
      return { url, title: title ?? '', text: stripHtml(html) };
    },
  };
}

/** Built-in tools available to every bot: file I/O, shell, and web. */
export function createBuiltInTools(opts: { workspaceDir: WorkspaceSource }): ToolDefinition[] {
  const { workspaceDir } = opts;
  return [
    readFileTool(workspaceDir),
    writeFileTool(workspaceDir),
    runCommandTool(workspaceDir),
    webSearchTool(),
    webFetchTool(),
  ];
}
