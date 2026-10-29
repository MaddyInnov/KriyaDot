// SPDX-License-Identifier: Apache-2.0
// Connectors as tools (Octop §2.9): external services exposed directly as
// agent tools instead of only through Composio —
//
//   openalex_search       OpenAlex works API (keyless; OPENALEX_MAILTO
//                         joins the polite pool when set)
//   ticktick_list_tasks   TickTick Open API (TICKTICK_ACCESS_TOKEN)
//   ticktick_create_task
//   obsidian_search       local Obsidian vault (OBSIDIAN_VAULT_PATH)
//   obsidian_read_note    traversal-safe reads inside the vault only
//   dify_run_app          run a Dify app (DIFY_API_URL + DIFY_API_KEY)
//
// Every tool resolves its config at call time and fails with a clear
// "not configured: set X" error when its env is missing. Fetch is
// injectable for tests (zero real network in the test suite).

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@mvp/agent-runtime';

export interface ConnectorToolsOptions {
  /** Injectable fetch (tests stub it). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Env source. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

type Ctx = ConnectorToolsOptions;

function fetchOf(opts: Ctx): typeof fetch {
  return opts.fetchFn ?? fetch;
}
function envOf(opts: Ctx): Record<string, string | undefined> {
  return opts.env ?? process.env;
}

function requireEnv(opts: Ctx, name: string, hint: string): string {
  const value = (envOf(opts)[name] ?? '').trim();
  if (!value) throw new Error(`Not configured: set ${name} (${hint}).`);
  return value;
}

async function jsonFetch(
  opts: Ctx,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  label: string,
): Promise<unknown> {
  const res = await fetchOf(opts)(url, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${label} failed: HTTP ${res.status}`);
  return res.json();
}

function strArg(args: Record<string, unknown>, name: string, required = true): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`"${name}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new Error(`"${name}" must be a string`);
  return v;
}

// ---------------------------------------------------------------------------
// OpenAlex (keyless scholarly search)
// ---------------------------------------------------------------------------

export function createOpenAlexSearchTool(opts: Ctx = {}): ToolDefinition {
  return {
    name: 'openalex_search',
    description:
      'Search scholarly works via the OpenAlex API (keyless). Returns title, year, DOI, citation count and authors for the top matches.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (title/abstract keywords).' },
        limit: { type: 'number', description: 'Max results (default 5, max 25).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = strArg(args, 'query')!;
      const limitRaw = typeof args.limit === 'number' ? Math.floor(args.limit) : 5;
      const limit = Math.min(25, Math.max(1, limitRaw));
      const mailto = (envOf(opts).OPENALEX_MAILTO ?? '').trim();
      const url =
        `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}` +
        (mailto ? `&mailto=${encodeURIComponent(mailto)}` : '');
      const data = (await jsonFetch(opts, url, {}, 'OpenAlex search')) as {
        results?: Array<{
          id?: string;
          display_name?: string;
          publication_year?: number;
          doi?: string;
          cited_by_count?: number;
          authorships?: Array<{ author?: { display_name?: string } }>;
        }>;
      };
      return {
        ok: true,
        results: (data.results ?? []).map((w) => ({
          id: w.id,
          title: w.display_name,
          year: w.publication_year,
          doi: w.doi,
          citedByCount: w.cited_by_count,
          authors: (w.authorships ?? [])
            .map((a) => a.author?.display_name)
            .filter(Boolean)
            .slice(0, 5),
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// TickTick (Open API v1)
// ---------------------------------------------------------------------------

const TICKTICK_BASE = 'https://api.ticktick.com/open/v1';

function ticktickHeaders(opts: Ctx): Record<string, string> {
  const token = requireEnv(opts, 'TICKTICK_ACCESS_TOKEN', 'TickTick Settings → Calendar & Widgets → Manage API tokens');
  return { authorization: `Bearer ${token}` };
}

export function createTickTickListTasksTool(opts: Ctx = {}): ToolDefinition {
  return {
    name: 'ticktick_list_tasks',
    description: 'List open TickTick tasks across all projects (title, project, due date, priority).',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Restrict to one project id.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const headers = ticktickHeaders(opts);
      const projectId = strArg(args, 'projectId', false);
      const projects = (await jsonFetch(opts, `${TICKTICK_BASE}/project`, { headers }, 'TickTick list projects')) as Array<{
        id: string;
        name?: string;
      }>;
      const targets = projectId ? projects.filter((p) => p.id === projectId) : projects;
      if (projectId && targets.length === 0) throw new Error(`TickTick project "${projectId}" not found.`);
      const tasks: Array<Record<string, unknown>> = [];
      for (const project of targets.slice(0, 20)) {
        const data = (await jsonFetch(
          opts,
          `${TICKTICK_BASE}/project/${encodeURIComponent(project.id)}/data`,
          { headers },
          'TickTick list tasks',
        )) as { tasks?: Array<Record<string, unknown>> };
        for (const t of data.tasks ?? []) {
          if (t.status === 2) continue; // completed
          tasks.push({
            id: t.id,
            title: t.title,
            projectId: project.id,
            projectName: project.name,
            dueDate: t.dueDate,
            priority: t.priority,
          });
          if (tasks.length >= 200) break;
        }
        if (tasks.length >= 200) break;
      }
      return { ok: true, tasks };
    },
  };
}

export function createTickTickCreateTaskTool(opts: Ctx = {}): ToolDefinition {
  return {
    name: 'ticktick_create_task',
    description: 'Create a TickTick task in a project.',
    mutating: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title.' },
        projectId: { type: 'string', description: 'Project id (see ticktick_list_tasks).' },
        content: { type: 'string', description: 'Optional task notes.' },
        dueDate: { type: 'string', description: 'Optional due date, ISO 8601 with timezone offset.' },
        priority: { type: 'number', description: 'Optional priority: 0 none, 1 low, 3 medium, 5 high.' },
      },
      required: ['title', 'projectId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const headers = ticktickHeaders(opts);
      const body: Record<string, unknown> = {
        title: strArg(args, 'title'),
        projectId: strArg(args, 'projectId'),
      };
      const content = strArg(args, 'content', false);
      if (content) body.content = content;
      const dueDate = strArg(args, 'dueDate', false);
      if (dueDate) body.dueDate = dueDate;
      if (typeof args.priority === 'number') body.priority = args.priority;
      const created = (await jsonFetch(
        opts,
        `${TICKTICK_BASE}/task`,
        { method: 'POST', headers, body: JSON.stringify(body) },
        'TickTick create task',
      )) as { id?: string };
      return { ok: true, taskId: created.id, title: body.title, projectId: body.projectId };
    },
  };
}

// ---------------------------------------------------------------------------
// Obsidian (local vault directory)
// ---------------------------------------------------------------------------

export function resolveObsidianVault(opts: Ctx): string {
  const vault = requireEnv(opts, 'OBSIDIAN_VAULT_PATH', 'absolute path of the Obsidian vault directory');
  const resolved = path.resolve(vault);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Obsidian vault not found: OBSIDIAN_VAULT_PATH="${vault}" is not a directory.`);
  }
  return resolved;
}

const MAX_VAULT_FILES = 2000;
const MAX_NOTE_CHARS = 50_000;

function listMarkdownFiles(vault: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= MAX_VAULT_FILES) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue; // .obsidian, .trash, …
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
      if (out.length >= MAX_VAULT_FILES) return;
    }
  };
  walk(vault);
  return out;
}

/** Resolve a vault-relative note path, refusing anything outside the vault. */
export function resolveVaultNotePath(vault: string, notePath: string): string {
  const candidate = path.resolve(vault, notePath);
  const vaultReal = fs.realpathSync(vault);
  const rel = path.relative(vaultReal, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refused: "${notePath}" resolves outside the Obsidian vault.`);
  }
  if (!fs.existsSync(candidate)) throw new Error(`Note not found in vault: "${notePath}"`);
  const real = fs.realpathSync(candidate);
  const relReal = path.relative(vaultReal, real);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw new Error(`Refused: "${notePath}" resolves outside the Obsidian vault (symlink).`);
  }
  return real;
}

export function createObsidianSearchTool(opts: Ctx = {}): ToolDefinition {
  return {
    name: 'obsidian_search',
    description: 'Search the local Obsidian vault (note titles + content) for a query string.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (case-insensitive).' },
        limit: { type: 'number', description: 'Max matches (default 10, max 50).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const vault = resolveObsidianVault(opts);
      const query = strArg(args, 'query')!.toLowerCase();
      const limitRaw = typeof args.limit === 'number' ? Math.floor(args.limit) : 10;
      const limit = Math.min(50, Math.max(1, limitRaw));
      const matches: Array<{ path: string; title: string; snippet: string }> = [];
      for (const file of listMarkdownFiles(vault)) {
        const rel = path.relative(vault, file);
        let snippet = '';
        if (!rel.toLowerCase().includes(query)) {
          let content: string;
          try {
            content = fs.readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          const idx = content.toLowerCase().indexOf(query);
          if (idx === -1) continue;
          snippet = content.slice(Math.max(0, idx - 60), idx + query.length + 120).replace(/\s+/g, ' ').trim();
        }
        matches.push({ path: rel, title: path.basename(file, '.md'), snippet });
        if (matches.length >= limit) break;
      }
      return { ok: true, vault, matches };
    },
  };
}

export function createObsidianReadNoteTool(opts: Ctx = {}): ToolDefinition {
  return {
    name: 'obsidian_read_note',
    description: 'Read one note from the local Obsidian vault by vault-relative path (e.g. "Projects/Plan.md").',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path of the note.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const vault = resolveObsidianVault(opts);
      const notePath = strArg(args, 'path')!;
      const resolved = resolveVaultNotePath(vault, notePath);
      const content = fs.readFileSync(resolved, 'utf8');
      return {
        ok: true,
        path: path.relative(vault, resolved),
        content: content.slice(0, MAX_NOTE_CHARS),
        truncated: content.length > MAX_NOTE_CHARS,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Dify (run a workflow/chat app)
// ---------------------------------------------------------------------------

export function createDifyRunAppTool(opts: Ctx = {}): ToolDefinition {
  return {
    name: 'dify_run_app',
    description:
      'Run a Dify workflow app with the given inputs (blocking mode) and return its outputs. Configure DIFY_API_URL (base, e.g. https://api.dify.ai/v1) and DIFY_API_KEY.',
    mutating: true,
    parameters: {
      type: 'object',
      properties: {
        inputs: { type: 'object', description: 'Input variables for the Dify app.' },
        user: { type: 'string', description: 'End-user identifier passed to Dify (default "kriyadot").' },
      },
      required: ['inputs'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const base = requireEnv(opts, 'DIFY_API_URL', 'the Dify API base URL').replace(/\/+$/, '');
      const key = requireEnv(opts, 'DIFY_API_KEY', 'the Dify app API key');
      const inputs = args.inputs;
      if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
        throw new Error('"inputs" must be an object');
      }
      const data = (await jsonFetch(
        opts,
        `${base}/workflows/run`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${key}` },
          body: JSON.stringify({
            inputs,
            response_mode: 'blocking',
            user: strArg(args, 'user', false) ?? 'kriyadot',
          }),
        },
        'Dify run app',
      )) as { data?: { outputs?: unknown; status?: string; error?: string }; outputs?: unknown };
      const inner = (data.data ?? data) as { outputs?: unknown; status?: string; error?: string };
      if (inner.status === 'failed') throw new Error(`Dify run failed: ${inner.error ?? 'unknown error'}`);
      return { ok: true, outputs: inner.outputs ?? inner };
    },
  };
}

/** All §2.9 connector tools. */
export function createConnectorTools(opts: Ctx = {}): ToolDefinition[] {
  return [
    createOpenAlexSearchTool(opts),
    createTickTickListTasksTool(opts),
    createTickTickCreateTaskTool(opts),
    createObsidianSearchTool(opts),
    createObsidianReadNoteTool(opts),
    createDifyRunAppTool(opts),
  ];
}
