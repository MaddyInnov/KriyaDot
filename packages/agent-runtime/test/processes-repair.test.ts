// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 3 (PROCESSES & REPAIR): CA-13 background processes, ADD-6
 * build-and-repair loop, CA-12 agent todos, CA-3 sandbox-auto-allow.
 *
 * Process tests spawn real short-lived shell commands on the local
 * sandbox path (Landlock on this host). The build-repair fixture is a
 * real temp TS project compiled with the repo's own tsc — no network.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ProcessRegistry,
  createProcessTools,
  drainProcessNotesIntoSteer,
} from '../src/tools/processes.js';
import { AgentTodoStore, createTaskTools, getSessionTodos } from '../src/tools/tasks.js';
import {
  detectBuildProject,
  parseBuildErrors,
  planDeterministicFixes,
  runBuildRepair,
} from '../src/build-repair.js';
import {
  evaluateSandboxAutoAllow,
  sandboxAutoAllowPolicyRules,
  withSandboxAutoAllowRules,
} from '../src/tools/sandbox-auto-allow.js';
import { SteerQueue } from '../src/steer.js';
import type { ToolContext, ToolDefinition } from '../src/types.js';

const CTX: ToolContext = { sessionId: 'sess-1', botId: 'bot-1' };
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(fn: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function byName(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map((t) => [t.name, t]));
}

// ---------------------------------------------------------------------------
// CA-13 — background processes
// ---------------------------------------------------------------------------

describe('CA-13 background processes', () => {
  it('starts, polls incremental output by offset, and lists', async () => {
    const ws = tmpDir('proc-ws-');
    const registry = new ProcessRegistry();
    cleanups.push(() => registry.disposeAll());
    const tools = byName(createProcessTools({ workspaceDir: ws, registry }));

    const started = (await tools.get('run_background')!.handler(
      { command: 'printf "one\\n"; sleep 0.3; printf "two\\n"' },
      CTX,
    )) as { processId: string; status: string; sandboxed: boolean };
    expect(started.status).toBe('running');
    expect(typeof started.sandboxed).toBe('boolean');

    await waitFor(() => registry.get(started.processId)?.status === 'exited');
    const first = (await tools.get('read_process_output')!.handler(
      { id: started.processId, sinceOffset: 0 },
      CTX,
    )) as { chunk: string; nextOffset: number; status: string; exitCode: number };
    expect(first.status).toBe('exited');
    expect(first.exitCode).toBe(0);
    expect(first.chunk).toContain('one');
    expect(first.chunk).toContain('two');
    // Incremental: reading again from nextOffset yields nothing new.
    const second = (await tools.get('read_process_output')!.handler(
      { id: started.processId, sinceOffset: first.nextOffset },
      CTX,
    )) as { chunk: string; nextOffset: number };
    expect(second.chunk).toBe('');
    expect(second.nextOffset).toBe(first.nextOffset);
    // Mid-stream offset returns only the tail.
    const tail = registry.readOutput(started.processId, first.nextOffset - 4)!;
    expect(tail.chunk).toBe('two\n');

    const listed = (await tools.get('list_processes')!.handler({}, CTX)) as {
      processes: Array<{ processId: string; status: string }>;
    };
    expect(listed.processes.map((p) => p.processId)).toContain(started.processId);
  }, 30_000);

  it('kills a long-running process and reaps the session on dispose', async () => {
    const ws = tmpDir('proc-ws-');
    const registry = new ProcessRegistry();
    cleanups.push(() => registry.disposeAll());
    const tools = byName(createProcessTools({ workspaceDir: ws, registry }));

    const started = (await tools.get('run_background')!.handler(
      { command: 'sleep 30' },
      CTX,
    )) as { processId: string };
    const killed = (await tools.get('kill_process')!.handler({ id: started.processId }, CTX)) as {
      killed: boolean;
    };
    expect(killed.killed).toBe(true);
    await waitFor(() => registry.get(started.processId)?.status !== 'running');

    const second = (await tools.get('run_background')!.handler(
      { command: 'sleep 30' },
      CTX,
    )) as { processId: string };
    expect(registry.disposeSession(CTX.sessionId)).toBe(1);
    await waitFor(() => registry.get(second.processId)?.status !== 'running');
  }, 30_000);

  it('refuses catastrophic commands and streams via subscribe + notes seam', async () => {
    const ws = tmpDir('proc-ws-');
    const registry = new ProcessRegistry();
    cleanups.push(() => registry.disposeAll());
    const tools = byName(createProcessTools({ workspaceDir: ws, registry }));
    await expect(
      tools.get('run_background')!.handler({ command: 'rm -rf / tmp' }, CTX),
    ).rejects.toThrow(/denylist/);

    const chunks: string[] = [];
    const started = (await tools.get('run_background')!.handler(
      { command: 'printf "hello-monitor\\n"' },
      CTX,
    )) as { processId: string };
    registry.subscribeProcessOutput(started.processId, (c) => chunks.push(c));
    // Subscribe happened after spawn; output may already be buffered —
    // the registry read path is authoritative either way.
    await waitFor(() => registry.get(started.processId)?.status === 'exited');
    const out = registry.readOutput(started.processId, 0)!;
    expect(out.chunk).toContain('hello-monitor');

    // Monitor seam: the exit queued a pending note; draining into a
    // SteerQueue moves it for the next turn boundary.
    const steer = new SteerQueue();
    const moved = drainProcessNotesIntoSteer(registry, steer, CTX.sessionId);
    expect(moved).toBeGreaterThanOrEqual(1);
    expect(steer.pending(CTX.sessionId)).toBe(moved);
    expect(SteerQueue.format(steer.drain(CTX.sessionId))).toContain(started.processId);
    expect(registry.pendingNotes(CTX.sessionId)).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// CA-12 — agent todos
// ---------------------------------------------------------------------------

describe('CA-12 agent todo tools', () => {
  it('supports create → list → update CRUD, scoped per session', async () => {
    const store = new AgentTodoStore();
    const tools = byName(createTaskTools({ store }));
    const created = (await tools.get('task_create')!.handler(
      { title: 'Write the parser', note: 'file:line patterns' },
      CTX,
    )) as { task: { id: string; status: string } };
    expect(created.task.status).toBe('pending');

    const updated = (await tools.get('task_update')!.handler(
      { id: created.task.id, status: 'in_progress' },
      CTX,
    )) as { task: { status: string } };
    expect(updated.task.status).toBe('in_progress');

    const done = (await tools.get('task_update')!.handler(
      { id: created.task.id, status: 'done' },
      CTX,
    )) as { task: { status: string } };
    expect(done.task.status).toBe('done');

    const listed = (await tools.get('task_list')!.handler({}, CTX)) as {
      tasks: Array<{ title: string }>;
    };
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]!.title).toBe('Write the parser');

    // Render seam: the getter Activity/chat reads.
    expect(getSessionTodos(CTX.sessionId, store)).toHaveLength(1);
    // Session isolation.
    expect(getSessionTodos('other-session', store)).toEqual([]);
    const other = (await tools.get('task_list')!.handler({}, { sessionId: 'other', botId: 'b' })) as {
      tasks: unknown[];
    };
    expect(other.tasks).toEqual([]);
    // Bad status + unknown id are honest errors, not throws.
    const bad = (await tools.get('task_update')!.handler(
      { id: created.task.id, status: 'nope' },
      CTX,
    )) as { error?: string };
    expect(bad.error).toMatch(/status/);
    const missing = (await tools.get('task_update')!.handler({ id: 'task-zzz', status: 'done' }, CTX)) as {
      error?: string;
    };
    expect(missing.error).toMatch(/no task/);
  });
});

// ---------------------------------------------------------------------------
// ADD-6 — build-and-repair
// ---------------------------------------------------------------------------

function findTsc(): string {
  // Walk up from this test file to the monorepo root's typescript.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('typescript not found in any ancestor node_modules');
}

describe('ADD-6 build-and-repair loop', () => {
  // The loop's default exec is the sandboxed command path, which fails
  // closed when no kernel/container backend exists unless the operator
  // opts into host execution. CI runners expose no Landlock backend
  // (seccomp), so without this opt-out every cycle is refused and the
  // loop escalates with no diagnostics — the tests below exercise the
  // loop itself, so they take the documented opt-out (sandbox.ts).
  let prevAllowHost: string | undefined;
  beforeAll(() => {
    prevAllowHost = process.env.SANDBOX_ALLOW_HOST;
    process.env.SANDBOX_ALLOW_HOST = '1';
  });
  afterAll(() => {
    if (prevAllowHost === undefined) delete process.env.SANDBOX_ALLOW_HOST;
    else process.env.SANDBOX_ALLOW_HOST = prevAllowHost;
  });

  it('detects project kinds and discovers commands', () => {
    const ws = tmpDir('br-detect-');
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'tsc', test: 'vitest' } }));
    const node = detectBuildProject(ws);
    expect(node.kind).toBe('node');
    expect(node.buildCommand).toBe('npm run build');
    expect(node.testCommand).toBe('npm test');
    const ws2 = tmpDir('br-detect2-');
    writeFileSync(join(ws2, 'Cargo.toml'), '[package]\nname="x"\n');
    expect(detectBuildProject(ws2)).toMatchObject({ kind: 'rust', buildCommand: 'cargo build' });
    const ws3 = tmpDir('br-detect3-');
    writeFileSync(join(ws3, 'Makefile'), 'build:\n\techo ok\n\ntest:\n\techo t\n');
    expect(detectBuildProject(ws3)).toMatchObject({ kind: 'make', buildCommand: 'make build', testCommand: 'make test' });
  });

  it('parses tsc, cargo, go, pytest and generic errors to file:line', () => {
    const tsc = parseBuildErrors("src/index.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.");
    expect(tsc[0]).toMatchObject({ file: 'src/index.ts', line: 3, col: 14, code: 'TS2322', source: 'tsc' });
    const cargo = parseBuildErrors('error[E0308]: mismatched types\n  --> src/main.rs:2:5\n');
    expect(cargo[0]).toMatchObject({ file: 'src/main.rs', line: 2, col: 5, source: 'cargo' });
    const go = parseBuildErrors('./main.go:10:2: undefined: foo');
    expect(go[0]).toMatchObject({ line: 10, col: 2, source: 'go' });
    const eslint = parseBuildErrors('/proj/src/a.ts\n  1:5  error  Missing semicolon  semi\n');
    expect(eslint[0]).toMatchObject({ file: '/proj/src/a.ts', line: 1, col: 5, source: 'eslint' });
  });

  it('fixes a broken TS fixture project to green with the local tsc', async () => {
    const ws = tmpDir('br-fixture-');
    const tscPath = findTsc();
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(
      join(ws, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        scripts: { build: `node ${tscPath} --noEmit -p tsconfig.json` },
      }),
    );
    writeFileSync(
      join(ws, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, noEmit: true },
        include: ['src'],
      }),
    );
    writeFileSync(join(ws, 'src', 'index.ts'), 'export const count: number = "42";\nexport const label: string = "answer";\n');

    const result = await runBuildRepair({ projectDir: ws });
    expect(result.status).toBe('green');
    expect(result.project.kind).toBe('node');
    expect(result.cycles.length).toBeGreaterThanOrEqual(2);
    const failing = result.cycles.find((c) => c.exitCode !== 0);
    expect(failing?.errorCount).toBeGreaterThanOrEqual(1);
    const patchCycle = result.cycles.find((c) => c.filesPatched.length > 0);
    expect(patchCycle?.filesPatched).toContain('src/index.ts');
    expect(readFileSync(join(ws, 'src', 'index.ts'), 'utf8')).toContain('export const count: number = 42;');
  }, 120_000);

  it('build_and_repair TOOL patches through the coding edit tool layer', async () => {
    const { createBuildRepairTools } = await import('../src/build-repair.js');
    const ws = tmpDir('br-tool-');
    const tscPath = findTsc();
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(
      join(ws, 'package.json'),
      JSON.stringify({
        name: 'fixture-tool',
        version: '1.0.0',
        scripts: { build: `node ${tscPath} --noEmit -p tsconfig.json` },
      }),
    );
    writeFileSync(
      join(ws, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, noEmit: true },
        include: ['src'],
      }),
    );
    writeFileSync(join(ws, 'src', 'index.ts'), 'export const flag: boolean = "true";\n');
    const tools = byName(createBuildRepairTools({ workspaceDir: ws }));
    const result = (await tools.get('build_and_repair')!.handler({}, CTX)) as {
      status: string;
      summary: string;
      attempts: Array<{ step: string }>;
    };
    expect(result.status).toBe('green');
    expect(result.attempts.length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(ws, 'src', 'index.ts'), 'utf8')).toContain('export const flag: boolean = true;');
  }, 120_000);

  it('escalates with the full trail when no deterministic fix applies', async () => {
    const ws = tmpDir('br-stuck-');
    writeFileSync(
      join(ws, 'package.json'),
      JSON.stringify({ name: 'stuck', scripts: { build: 'node -e "console.error(\'src/x.ts(1,1): error TS9999: hopeless\'); process.exit(2)"' } }),
    );
    const result = await runBuildRepair({ projectDir: ws, maxCycles: 3 });
    expect(result.status).toBe('escalated');
    expect(result.escalation).toContain('What was tried');
    expect(result.errorsRemaining[0]).toMatchObject({ code: 'TS9999' });
    const plans = planDeterministicFixes(result.errorsRemaining, ws);
    expect(plans).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// CA-3 — sandbox-auto-allow policy matrix
// ---------------------------------------------------------------------------

describe('CA-3 sandbox-auto-allow', () => {
  it('flag OFF → never auto-allows, even when confined', () => {
    const r = evaluateSandboxAutoAllow({ enabled: false, toolName: 'run_command', command: 'echo hi', backend: 'landlock' });
    expect(r.allow).toBe(false);
    expect(r.confined).toBe(true);
    const r2 = evaluateSandboxAutoAllow({ toolName: 'run_command', command: 'echo hi', backend: 'docker' });
    expect(r2.allow).toBe(false);
  });

  it('flag ON + confined backend → allowed without prompt', () => {
    for (const backend of ['landlock', 'seatbelt', 'docker', 'e2b']) {
      const r = evaluateSandboxAutoAllow({ enabled: true, toolName: 'run_command', command: 'npm run build', backend });
      expect(r.allow).toBe(true);
      expect(r.confined).toBe(true);
    }
    const bg = evaluateSandboxAutoAllow({ enabled: true, toolName: 'run_background', command: 'npm run dev', backend: 'landlock' });
    expect(bg.allow).toBe(true);
  });

  it('flag ON + unconfined host/none → NOT allowed', () => {
    for (const backend of ['host', 'none']) {
      const r = evaluateSandboxAutoAllow({ enabled: true, toolName: 'run_command', command: 'echo hi', backend });
      expect(r.allow).toBe(false);
      expect(r.confined).toBe(false);
    }
  });

  it('flag ON + catastrophic command → hard-denied even when confined', () => {
    const r = evaluateSandboxAutoAllow({ enabled: true, toolName: 'run_command', command: 'rm -rf /', backend: 'docker' });
    expect(r.allow).toBe(false);
    expect(r.blockedBy).toBe('hard-deny');
    const r2 = evaluateSandboxAutoAllow({ enabled: true, toolName: 'run_background', command: 'mkfs.ext4 /dev/sda', backend: 'landlock' });
    expect(r2.allow).toBe(false);
    expect(r2.blockedBy).toBe('hard-deny');
  });

  it('non-command tools never qualify; policy rules only merge when enabled', () => {
    const r = evaluateSandboxAutoAllow({ enabled: true, toolName: 'write_file', command: 'echo hi', backend: 'landlock' });
    expect(r.allow).toBe(false);
    const base = { rules: [{ id: 'x', toolPattern: '^a$', effect: 'allow' as const }], sandboxAutoAllow: undefined };
    expect(withSandboxAutoAllowRules(base, false)).toBe(base);
    const merged = withSandboxAutoAllowRules(base, true);
    expect(merged.rules[0]!.id).toBe('sandbox-auto-allow-commands');
    expect(sandboxAutoAllowPolicyRules()[0]!.effect).toBe('allow');
    // silence unused warning for resolve import parity
    expect(resolve('.')).toBeTruthy();
  });
});
