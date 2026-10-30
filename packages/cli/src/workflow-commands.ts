// SPDX-License-Identifier: Apache-2.0
// `kriyadot workflows …` — the workflow surface from the terminal
// (#143/#151/#155, CLI side).
//
//   workflows list
//       GET /workflows — every registered workflow definition.
//   workflows dry-run <id>
//       POST /workflows/<id>/dry-run — the execution plan (which nodes
//       run, in what order, priced) WITHOUT spawning anything.
//   workflows run <name|id> [--input '<json>']
//       POST /workflows/<id>/run — starts a real run; the target
//       resolves by id first, then by workflow NAME (#155 run-by-name).
import { flagString } from './args.js';
import type { ParsedArgs } from './args.js';
import type { CommandDeps } from './commands.js';
import { EXIT_ERROR, EXIT_USAGE } from './exits.js';

export interface WorkflowSummary {
  id: string;
  name: string;
  nodes?: unknown[];
  [key: string]: unknown;
}

function out(deps: CommandDeps, s: string): void {
  deps.stdout.write(s);
}
function err(deps: CommandDeps, s: string): void {
  deps.stderr.write(s);
}

const WORKFLOWS_USAGE = 'Usage: kriyadot workflows <list|dry-run <id>|run <name|id> [--input <json>]>';

async function listWorkflows(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const defs = await deps.api.request<WorkflowSummary[]>('/workflows');
  if (p.global.format === 'json') {
    out(deps, `${JSON.stringify(defs, null, 2)}\n`);
    return 0;
  }
  if (defs.length === 0) {
    out(deps, 'No workflows registered.\n');
    return 0;
  }
  for (const d of defs) {
    out(deps, `${d.id}\t${d.name}\t${Array.isArray(d.nodes) ? `${d.nodes.length} nodes` : ''}\n`);
  }
  return 0;
}

async function dryRunWorkflow(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const id = p.positional[0];
  if (!id) {
    err(deps, 'Usage: kriyadot workflows dry-run <id>\n');
    return EXIT_USAGE;
  }
  const res = await deps.api.request<{ ok: boolean; plan: unknown }>(
    `/workflows/${encodeURIComponent(id)}/dry-run`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  out(deps, `${JSON.stringify(res.plan ?? res, null, 2)}\n`);
  return 0;
}

async function runWorkflow(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const target = p.positional[0];
  if (!target) {
    err(deps, 'Usage: kriyadot workflows run <name|id> [--input <json>]\n');
    return EXIT_USAGE;
  }
  // Resolve by id first, then by name (#155).
  const defs = await deps.api.request<WorkflowSummary[]>('/workflows');
  const def = defs.find((d) => d.id === target) ?? defs.find((d) => d.name === target);
  if (!def) {
    err(deps, `kriyadot workflows: no workflow with id or name "${target}"\n`);
    return EXIT_ERROR;
  }
  let input: unknown = {};
  const rawInput = flagString(p.flags, 'input');
  if (rawInput !== undefined) {
    try {
      input = JSON.parse(rawInput);
    } catch {
      err(deps, 'kriyadot workflows run: --input must be valid JSON\n');
      return EXIT_USAGE;
    }
  }
  const res = await deps.api.request<{ id?: string; status?: string }>(
    `/workflows/${encodeURIComponent(def.id)}/run`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    },
  );
  if (p.global.format === 'json') {
    out(deps, `${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }
  out(deps, `Started workflow "${def.name}" (${def.id})${res.id ? ` — run ${res.id}` : ''}${res.status ? ` [${res.status}]` : ''}\n`);
  return 0;
}

/** Dispatch a parsed `workflows` invocation. Returns the process exit code. */
export async function runWorkflowCommand(p: ParsedArgs, deps: CommandDeps): Promise<number> {
  try {
    switch (p.subcommand) {
      case '':
      case 'list':
        return await listWorkflows(deps, p);
      case 'dry-run':
        return await dryRunWorkflow(deps, p);
      case 'run':
        return await runWorkflow(deps, p);
      default:
        err(deps, `${WORKFLOWS_USAGE}\n`);
        return EXIT_USAGE;
    }
  } catch (e) {
    err(deps, `kriyadot: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_ERROR;
  }
}
