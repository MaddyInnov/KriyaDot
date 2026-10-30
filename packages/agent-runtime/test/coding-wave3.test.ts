// SPDX-License-Identifier: Apache-2.0
// Wave-3 coding-core closure tests (ADD-7):
//   CA-9  — managed LSP fleet: lifecycle, diagnostics, post-edit append
//   CA-10 — formatter pipeline (fake formatter command)
//   CA-11 — .gitignore / .kriyadotignore awareness in glob/grep
//   CA-14 — notebook_read / notebook_edit
//   CA-26 — multi-root sessions
// Everything is hermetic: the LSP server is the fake fixture in
// test/fixtures/, formatters are injected fakes, no network, no downloads.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodingTools } from '../src/tools/coding.js';
import { LspManager, summarizeDiagnostics } from '../src/lsp/manager.js';
import { parseDiagnostics } from '../src/lsp/client.js';
import { gitignorePatternToRegExp, parseIgnoreFile, IgnoreMatcher } from '../src/tools/ignore.js';
import type { FormatterRunner } from '../src/tools/formatters.js';
import type { ToolContext, ToolDefinition } from '../src/types.js';

const CTX: ToolContext = { sessionId: 's', botId: 'b' };
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-lsp-server.mjs');

/** Spawn function that runs the fake LSP server regardless of the requested binary. */
const fakeSpawn = ((_cmd: string, _args: string[], opts: { cwd: string }) =>
  spawn(process.execPath, [FIXTURE], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })) as never;

const managers: LspManager[] = [];
function fakeManager(extra: Record<string, unknown> = {}): LspManager {
  const m = new LspManager({ spawnFn: fakeSpawn, diagnosticsWaitMs: 2_000, ...extra });
  managers.push(m);
  return m;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose()));
});

function byName(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map((t) => [t.name, t]));
}

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// CA-9 — LSP manager lifecycle + tools
// ---------------------------------------------------------------------------

describe('CA-9 managed LSP fleet', () => {
  it('parses publishDiagnostics params defensively', () => {
    expect(parseDiagnostics(null)).toEqual([]);
    expect(parseDiagnostics({ diagnostics: 'nope' })).toEqual([]);
    const parsed = parseDiagnostics({
      diagnostics: [
        { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, severity: 1, message: 'boom', source: 'x' },
        { nope: true },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.message).toBe('boom');
  });

  it('summarizes diagnostics with severity counts and a cap', () => {
    const diags = Array.from({ length: 15 }, (_, i) => ({
      range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
      severity: i < 3 ? 1 : 2,
      message: `m${i}`,
    }));
    const s = summarizeDiagnostics('a.ts', diags);
    expect(s.errors).toBe(3);
    expect(s.warnings).toBe(12);
    expect(s.total).toBe(15);
    expect(s.items).toHaveLength(10); // capped
  });

  it('spawns lazily, reuses one process per root, and serves definition/hover/references', async () => {
    const dir = await tmp('lsp-');
    await writeFile(join(dir, 'a.ts'), 'const x = 1;\n', 'utf8');
    const manager = fakeManager();
    const tools = byName(createCodingTools({ workspaceDir: dir, lspManager: manager }));
    expect(manager.activeServerCount).toBe(0); // lazy: nothing spawned yet

    const def = (await tools.get('lsp_definition')!.handler({ path: 'a.ts', line: 0, character: 6 }, CTX)) as {
      locations: { line?: number }[];
    };
    expect(def.locations).toHaveLength(1);
    expect(manager.activeServerCount).toBe(1);

    const hover = (await tools.get('lsp_hover')!.handler({ path: 'a.ts', line: 0, character: 6 }, CTX)) as {
      contents: { value: string };
    };
    expect(hover.contents.value).toBe('fake hover text');

    const refs = (await tools.get('lsp_references')!.handler({ path: 'a.ts', line: 0, character: 6 }, CTX)) as {
      locations: unknown[];
    };
    expect(refs.locations).toHaveLength(2);
    expect(manager.activeServerCount).toBe(1); // still one reused process
  });

  it('lsp_diagnostics returns parsed diagnostics for a file and for the workspace', async () => {
    const dir = await tmp('lsp-diag-');
    await writeFile(join(dir, 'bad.ts'), 'const a = lsp_error here;\nconst b = lsp_warn too;\n', 'utf8');
    await writeFile(join(dir, 'good.ts'), 'const ok = 1;\n', 'utf8');
    const manager = fakeManager();
    const tools = byName(createCodingTools({ workspaceDir: dir, lspManager: manager }));
    const diag = tools.get('lsp_diagnostics')!;

    const one = (await diag.handler({ path: 'bad.ts' }, CTX)) as {
      diagnostics: { errors: number; warnings: number; total: number }[];
    };
    expect(one.diagnostics[0]!.errors).toBe(1);
    expect(one.diagnostics[0]!.warnings).toBe(1);
    expect(one.diagnostics[0]!.total).toBe(2);

    const ws = (await diag.handler({}, CTX)) as { diagnostics: { file: string }[]; filesChecked: number };
    expect(ws.filesChecked).toBe(2);
    expect(ws.diagnostics.map((d) => d.file)).toEqual(['bad.ts']); // only files WITH diagnostics
  });

  it('shuts servers down on idle and on dispose', async () => {
    const dir = await tmp('lsp-idle-');
    await writeFile(join(dir, 'a.ts'), 'const x = 1;\n', 'utf8');
    const manager = fakeManager({ idleTimeoutMs: 60 });
    const res = await manager.getDiagnostics(dir, join(dir, 'a.ts'));
    expect(res.ok).toBe(true);
    expect(manager.activeServerCount).toBe(1);
    await new Promise((r) => setTimeout(r, 250));
    expect(manager.activeServerCount).toBe(0); // idle shutdown fired

    const manager2 = fakeManager();
    await manager2.getDiagnostics(dir, join(dir, 'a.ts'));
    expect(manager2.activeServerCount).toBe(1);
    await manager2.dispose();
    expect(manager2.activeServerCount).toBe(0);
  });

  it('degrades gracefully (never throws) when the server binary is missing', async () => {
    const dir = await tmp('lsp-missing-');
    await writeFile(join(dir, 'a.ts'), 'const x = 1;\n', 'utf8');
    const missingSpawn = ((_cmd: string, _args: string[], opts: { cwd: string }) =>
      spawn('kriyadot-no-such-lsp-binary', [], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })) as never;
    const manager = new LspManager({ spawnFn: missingSpawn, diagnosticsWaitMs: 100 });
    managers.push(manager);
    const tools = byName(createCodingTools({ workspaceDir: dir, lspManager: manager }));
    const d = (await tools.get('lsp_definition')!.handler({ path: 'a.ts', line: 0, character: 0 }, CTX)) as {
      degraded?: boolean;
      error?: string;
    };
    expect(d.degraded).toBe(true);
    expect(d.error).toMatch(/not available/);
    const diag = (await tools.get('lsp_diagnostics')!.handler({ path: 'a.ts' }, CTX)) as { degraded?: boolean };
    expect(diag.degraded).toBe(true);
  });

  it('appends post-edit diagnostics to edit results (CA-9)', async () => {
    const dir = await tmp('lsp-postedit-');
    await writeFile(join(dir, 'a.ts'), 'const x = 1;\n', 'utf8');
    const manager = fakeManager();
    const tools = byName(createCodingTools({ workspaceDir: dir, lspManager: manager }));
    const edit = tools.get('edit')!;

    const clean = (await edit.handler({ path: 'a.ts', oldText: 'const x = 1;', newText: 'const x = 2;' }, CTX)) as {
      diagnostics?: unknown[];
    };
    expect(clean.diagnostics).toBeUndefined(); // no diagnostics → nothing appended

    const dirty = (await edit.handler(
      { path: 'a.ts', oldText: 'const x = 2;', newText: 'const x = lsp_error;' }, CTX,
    )) as { diagnostics?: { errors: number; file: string }[] };
    expect(dirty.diagnostics).toBeDefined();
    expect(dirty.diagnostics![0]!.errors).toBe(1);
    expect(dirty.diagnostics![0]!.file).toBe('a.ts');
  });
});

// ---------------------------------------------------------------------------
// CA-10 — formatter pipeline
// ---------------------------------------------------------------------------

describe('CA-10 formatter pipeline', () => {
  it('runs the configured formatter after edit and reports it', async () => {
    const dir = await tmp('fmt-');
    await writeFile(join(dir, 'a.ts'), 'const x=1;\n', 'utf8');
    const calls: { command: string; args: string[] }[] = [];
    const runner: FormatterRunner = (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const tools = byName(createCodingTools({
      workspaceDir: dir,
      formatterRunner: runner,
      formatters: { '.ts': { command: 'fakefmt', args: ['--write', '{file}'] } },
      lsp: { disabled: true },
    }));
    const res = (await tools.get('edit')!.handler(
      { path: 'a.ts', oldText: 'const x=1;', newText: 'const x=2;' }, CTX,
    )) as { formatting?: { formatted: boolean; formatter?: string }[] };
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('fakefmt');
    expect(calls[0]!.args).toContain(join(dir, 'a.ts'));
    expect(res.formatting?.[0]!.formatted).toBe(true);
  });

  it('surfaces formatter failure as a note and never fails the edit', async () => {
    const dir = await tmp('fmt-fail-');
    await writeFile(join(dir, 'a.ts'), 'const x=1;\n', 'utf8');
    const runner: FormatterRunner = () => ({ exitCode: 2, stdout: '', stderr: 'syntax exploded' });
    const tools = byName(createCodingTools({
      workspaceDir: dir,
      formatterRunner: runner,
      formatters: { '.ts': { command: 'fakefmt', args: ['{file}'] } },
      lsp: { disabled: true },
    }));
    const res = (await tools.get('edit')!.handler(
      { path: 'a.ts', oldText: 'const x=1;', newText: 'const x=2;' }, CTX,
    )) as { replacements: number; notes?: string[] };
    expect(res.replacements).toBe(1); // edit itself succeeded
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toContain('const x=2;');
    expect(res.notes?.join(' ')).toMatch(/formatter failed/);
  });

  it('honours .kriyadot/formatters.json from the project', async () => {
    const dir = await tmp('fmt-config-');
    await mkdir(join(dir, '.kriyadot'), { recursive: true });
    await writeFile(
      join(dir, '.kriyadot', 'formatters.json'),
      JSON.stringify({ formatters: { '.md': { command: 'mdfmt', args: ['{file}'] } } }),
      'utf8',
    );
    await writeFile(join(dir, 'README.md'), '# hi\n', 'utf8');
    const calls: string[] = [];
    const runner: FormatterRunner = (command) => {
      calls.push(command);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const tools = byName(createCodingTools({ workspaceDir: dir, formatterRunner: runner, lsp: { disabled: true } }));
    await tools.get('edit')!.handler({ path: 'README.md', oldText: '# hi', newText: '# hello' }, CTX);
    expect(calls).toEqual(['mdfmt']);
  });

  it('detects prettier from package.json evidence and uses the local bin', async () => {
    const dir = await tmp('fmt-prettier-');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ devDependencies: { prettier: '^3.0.0' } }), 'utf8');
    await writeFile(join(dir, 'a.ts'), 'const x=1;\n', 'utf8');
    const calls: string[] = [];
    const runner: FormatterRunner = (command) => {
      calls.push(command);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const tools = byName(createCodingTools({ workspaceDir: dir, formatterRunner: runner, lsp: { disabled: true } }));
    await tools.get('edit')!.handler({ path: 'a.ts', oldText: 'x=1', newText: 'x=2' }, CTX);
    expect(calls).toEqual(['prettier']); // no node_modules/.bin → PATH name, runner is fake
  });
});

// ---------------------------------------------------------------------------
// CA-11 — ignore awareness
// ---------------------------------------------------------------------------

describe('CA-11 .gitignore awareness', () => {
  it('pattern semantics: basename, anchored, dir-only, negation, **', () => {
    expect(gitignorePatternToRegExp('*.log').test('a/b/c.log')).toBe(true);
    expect(gitignorePatternToRegExp('*.log').test('a/b/c.txt')).toBe(false);
    expect(gitignorePatternToRegExp('/build').test('build/x.js')).toBe(true);
    expect(gitignorePatternToRegExp('/build').test('src/build/x.js')).toBe(false);
    expect(gitignorePatternToRegExp('docs/**').test('docs/a/b/c.md')).toBe(true);
    const rules = parseIgnoreFile('# comment\n*.log\n!important.log\nbuild/\n', '');
    const m = new IgnoreMatcher('/nonexistent-root-for-unit-test');
    // Inject the parsed rules by re-parsing through a matcher on a real dir is
    // covered by the glob test; here verify rule flags directly.
    expect(rules.map((r) => [r.pattern, r.negated, r.dirOnly])).toEqual([
      ['*.log', false, false],
      ['important.log', true, false],
      ['build', false, true],
    ]);
    expect(m.hasNegations).toBe(false);
  });

  async function fixture(): Promise<{ dir: string; tools: Map<string, ToolDefinition> }> {
    const dir = await tmp('ignore-');
    await writeFile(join(dir, '.gitignore'), 'ignored.txt\n*.log\n!important.log\nbuild/\n', 'utf8');
    await writeFile(join(dir, '.kriyadotignore'), 'secret.txt\n', 'utf8');
    await writeFile(join(dir, 'kept.ts'), 'export const needle = 1;\n', 'utf8');
    await writeFile(join(dir, 'ignored.txt'), 'needle in ignored\n', 'utf8');
    await writeFile(join(dir, 'secret.txt'), 'needle in secret\n', 'utf8');
    await writeFile(join(dir, 'debug.log'), 'needle in log\n', 'utf8');
    await writeFile(join(dir, 'important.log'), 'needle in important\n', 'utf8');
    await mkdir(join(dir, 'build'), { recursive: true });
    await writeFile(join(dir, 'build', 'out.ts'), 'needle in build\n', 'utf8');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', '.gitignore'), 'local.txt\n', 'utf8');
    await writeFile(join(dir, 'sub', 'local.txt'), 'needle local\n', 'utf8');
    await writeFile(join(dir, 'sub', 'visible.ts'), 'needle visible\n', 'utf8');
    return { dir, tools: byName(createCodingTools({ workspaceDir: dir, lsp: { disabled: true } })) };
  }

  it('glob honours root + nested ignore files by default; includeIgnored overrides', async () => {
    const { tools } = await fixture();
    const glob = tools.get('glob')!;
    const def = (await glob.handler({ pattern: '**' }, CTX)) as { matches: string[] };
    expect(def.matches).toContain('kept.ts');
    expect(def.matches).toContain('important.log'); // negation re-includes
    expect(def.matches).toContain('sub/visible.ts');
    expect(def.matches).not.toContain('ignored.txt');
    expect(def.matches).not.toContain('secret.txt'); // .kriyadotignore
    expect(def.matches).not.toContain('debug.log');
    expect(def.matches).not.toContain('build/out.ts'); // dir pattern prunes
    expect(def.matches).not.toContain('sub/local.txt'); // nested .gitignore

    const all = (await glob.handler({ pattern: '**', includeIgnored: true }, CTX)) as { matches: string[] };
    expect(all.matches).toContain('ignored.txt');
    expect(all.matches).toContain('build/out.ts');
    expect(all.matches).toContain('sub/local.txt');
  });

  it('grep honours ignore rules by default; includeIgnored overrides', async () => {
    const { tools } = await fixture();
    const grep = tools.get('grep')!;
    const def = (await grep.handler({ pattern: 'needle' }, CTX)) as { matches: { path: string }[] };
    const paths = def.matches.map((m) => m.path).sort();
    expect(paths).toEqual(['important.log', 'kept.ts', 'sub/visible.ts']);
    const all = (await grep.handler({ pattern: 'needle', includeIgnored: true }, CTX)) as {
      matches: { path: string }[];
    };
    expect(all.matches.length).toBeGreaterThan(def.matches.length);
    expect(all.matches.map((m) => m.path)).toContain('ignored.txt');
  });
});

// ---------------------------------------------------------------------------
// CA-14 — notebooks
// ---------------------------------------------------------------------------

describe('CA-14 notebook tools', () => {
  const NB = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3' } },
    cells: [
      { cell_type: 'markdown', id: 'cell-a', metadata: {}, source: ['# Title\n'] },
      { cell_type: 'code', id: 'cell-b', metadata: {}, source: ['x = 1\n'], outputs: [], execution_count: 1 },
      { cell_type: 'code', id: 'cell-c', metadata: {}, source: ['print(x)\n'], outputs: [], execution_count: 2 },
    ],
  };

  async function setup(): Promise<{ dir: string; tools: Map<string, ToolDefinition> }> {
    const dir = await tmp('nb-');
    await writeFile(join(dir, 'nb.ipynb'), JSON.stringify(NB, null, 1), 'utf8');
    return { dir, tools: byName(createCodingTools({ workspaceDir: dir, lsp: { disabled: true } })) };
  }

  it('notebook_read lists cells with ids, types and sources', async () => {
    const { tools } = await setup();
    const res = (await tools.get('notebook_read')!.handler({ path: 'nb.ipynb' }, CTX)) as {
      nbformat: number;
      cellCount: number;
      cells: { index: number; id?: string; type: string; source: string }[];
    };
    expect(res.nbformat).toBe(4);
    expect(res.cellCount).toBe(3);
    expect(res.cells[0]).toMatchObject({ index: 0, id: 'cell-a', type: 'markdown', source: '# Title\n' });
    expect(res.cells[1]!.source).toBe('x = 1\n');
  });

  it('notebook_edit replaces by id, inserts, deletes — preserving nbformat', async () => {
    const { dir, tools } = await setup();
    const edit = tools.get('notebook_edit')!;
    const read = tools.get('notebook_read')!;

    await edit.handler({ path: 'nb.ipynb', action: 'replace', cellId: 'cell-b', source: 'x = 42\n' }, CTX);
    let res = (await read.handler({ path: 'nb.ipynb' }, CTX)) as { cells: { source: string }[] };
    expect(res.cells[1]!.source).toBe('x = 42\n');

    const ins = (await edit.handler(
      { path: 'nb.ipynb', action: 'insert', cellIndex: 0, cellType: 'markdown', source: '## New\n' }, CTX,
    )) as { insertedAt: number; cellCount: number };
    expect(ins.insertedAt).toBe(1);
    expect(ins.cellCount).toBe(4);

    const del = (await edit.handler({ path: 'nb.ipynb', action: 'delete', cellIndex: 1 }, CTX)) as {
      cellCount: number;
    };
    expect(del.cellCount).toBe(3);

    const raw = JSON.parse(await readFile(join(dir, 'nb.ipynb'), 'utf8')) as {
      nbformat: number;
      metadata: { kernelspec: { name: string } };
      cells: { id?: string }[];
    };
    expect(raw.nbformat).toBe(4);
    expect(raw.metadata.kernelspec.name).toBe('python3'); // metadata preserved
    expect(raw.cells.map((c) => c.id)).toEqual(['cell-a', 'cell-b', 'cell-c']); // untouched cells intact

    await expect(
      edit.handler({ path: 'nb.ipynb', action: 'replace', cellId: 'nope', source: 'x' }, CTX),
    ).rejects.toThrow(/no cell with id/);
    await expect(
      edit.handler({ path: '../escape.ipynb', action: 'delete', cellIndex: 0 }, CTX),
    ).rejects.toThrow(/escapes workspace/);
    expect(existsSync(join(dir, 'nb.ipynb'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CA-26 — multi-root sessions
// ---------------------------------------------------------------------------

describe('CA-26 multi-root sessions', () => {
  it('resolves reads/writes across seeded roots, each confined to itself', async () => {
    const primary = await tmp('root-a-');
    const extra = await tmp('root-b-');
    await writeFile(join(primary, 'main.ts'), 'primary needle\n', 'utf8');
    await writeFile(join(extra, 'sibling.ts'), 'sibling needle\n', 'utf8');
    const tools = byName(createCodingTools({
      workspaceDir: primary,
      additionalRoots: [extra],
      lsp: { disabled: true },
    }));

    // Cross-root glob: the sibling file shows up, prefixed with its root name.
    const glob = (await tools.get('glob')!.handler({ pattern: '**/*.ts' }, CTX)) as { matches: string[] };
    expect(glob.matches).toContain('main.ts');
    expect(glob.matches.some((m) => m.endsWith('/sibling.ts'))).toBe(true);

    // Cross-root grep.
    const grep = (await tools.get('grep')!.handler({ pattern: 'needle' }, CTX)) as {
      matches: { path: string }[];
    };
    expect(grep.matches.map((m) => m.path).some((p) => p.endsWith('sibling.ts'))).toBe(true);

    // Edit a file that only exists in the extra root (relative resolution).
    const editRes = (await tools.get('edit')!.handler(
      { path: 'sibling.ts', oldText: 'sibling needle', newText: 'sibling edited' }, CTX,
    )) as { replacements: number };
    expect(editRes.replacements).toBe(1);
    expect(await readFile(join(extra, 'sibling.ts'), 'utf8')).toContain('sibling edited');

    // Escape rejection on BOTH roots.
    await expect(
      tools.get('edit')!.handler({ path: '../outside.ts', oldText: 'a', newText: 'b' }, CTX),
    ).rejects.toThrow(/escapes workspace/);
    await expect(
      tools.get('edit')!.handler({ path: join(extra, '..', 'outside.ts'), oldText: 'a', newText: 'b' }, CTX),
    ).rejects.toThrow(/escapes workspace/);
    await expect(
      tools.get('edit')!.handler({ path: '/etc/passwd', oldText: 'a', newText: 'b' }, CTX),
    ).rejects.toThrow(/escapes workspace/);
  });

  it('per-turn roots via ToolContext and mid-session add_workspace_dir both work', async () => {
    const primary = await tmp('root-main-');
    const turnRoot = await tmp('root-turn-');
    const sessionRoot = await tmp('root-session-');
    await writeFile(join(turnRoot, 'turn.ts'), 'turn file\n', 'utf8');
    await writeFile(join(sessionRoot, 'session.ts'), 'session file\n', 'utf8');
    const tools = byName(createCodingTools({ workspaceDir: primary, lsp: { disabled: true } }));

    const turnCtx: ToolContext = { ...CTX, additionalWorkspaceRoots: [turnRoot] };
    const glob1 = (await tools.get('glob')!.handler({ pattern: '**/*.ts' }, turnCtx)) as { matches: string[] };
    expect(glob1.matches.some((m) => m.endsWith('turn.ts'))).toBe(true);
    // Without the turn context the root is not visible.
    const glob0 = (await tools.get('glob')!.handler({ pattern: '**/*.ts' }, CTX)) as { matches: string[] };
    expect(glob0.matches.some((m) => m.endsWith('turn.ts'))).toBe(false);

    const added = (await tools.get('add_workspace_dir')!.handler({ path: sessionRoot }, CTX)) as {
      added: string;
      roots: string[];
    };
    expect(added.roots).toContain(sessionRoot);
    const glob2 = (await tools.get('glob')!.handler({ pattern: '**/*.ts' }, CTX)) as { matches: string[] };
    expect(glob2.matches.some((m) => m.endsWith('session.ts'))).toBe(true);

    await expect(tools.get('add_workspace_dir')!.handler({ path: join(primary, 'nope') }, CTX)).rejects.toThrow(
      /does not exist/,
    );
  });
});
