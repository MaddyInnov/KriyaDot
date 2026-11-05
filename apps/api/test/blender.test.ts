// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BLENDER_NOT_INSTALLED_ERROR,
  BLENDER_OPEN_FILE_TOOL,
  BLENDER_RENDER_TOOL,
  BLENDER_RUN_SCRIPT_TOOL,
  BLENDER_STATUS_TOOL,
  assertWorkspaceOutputPath,
  assertWorkspacePath,
  blenderToolPolicies,
  createBlenderOpenFileTool,
  createBlenderRenderTool,
  createBlenderRunScriptTool,
  createBlenderStatusTool,
  detectBlender,
  listLocalApps,
  parseBlenderVersion,
  registerBlenderTools,
  registerLocalAppRoutes,
  type BlenderPlatform,
  type BlenderProbeFs,
  type BlenderProcessRunner,
  type LocalAppsProbe,
} from '../src/blender.js';
import type { AppConfig } from '../src/config.js';
import type { ToolContext, ToolDefinition } from '@mvp/agent-runtime';

// Tests NEVER launch a real Blender or real processes: every process
// interaction goes through FakeRunner / FakeFs below.

const CTX: ToolContext = { sessionId: 's1', botId: 'bot-1' };

class FakeRunner implements BlenderProcessRunner {
  readonly calls: Array<{ argv: string[]; timeoutMs: number }> = [];
  whichResult: string | undefined = undefined;
  whichError: Error | undefined = undefined;
  versionOutput = 'Blender 4.2.1\nBlender Foundation\n';
  versionCode = 0;
  /** pgrep exit code (linux/darwin running check). */
  runningCode = 0;
  failRunning = false;
  /** tasklist stdout (win32 running check). */
  tasklistStdout = 'blender.exe                   4242 Console                    1    120,000 K\n';
  runCode = 0;
  runStdout = '';
  runStderr = '';

  async which(_name: string): Promise<string | undefined> {
    if (this.whichError) throw this.whichError;
    return this.whichResult;
  }

  async run(argv: string[], opts: { timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string }> {
    this.calls.push({ argv: [...argv], timeoutMs: opts.timeoutMs });
    if (argv[1] === '--version') {
      return { code: this.versionCode, stdout: this.versionOutput, stderr: '' };
    }
    if (argv[0] === 'pgrep') {
      if (this.failRunning) throw new Error('pgrep not available');
      return { code: this.runningCode, stdout: this.runningCode === 0 ? '4242\n' : '', stderr: '' };
    }
    if (argv[0] === 'tasklist') {
      if (this.failRunning) throw new Error('tasklist not available');
      return { code: 0, stdout: this.tasklistStdout, stderr: '' };
    }
    return { code: this.runCode, stdout: this.runStdout, stderr: this.runStderr };
  }

  /** The argv arrays of the actual Blender work calls (--background …). */
  backgroundCalls(): string[][] {
    return this.calls.filter((c) => c.argv.includes('--background')).map((c) => c.argv);
  }
}

class FakeFs implements BlenderProbeFs {
  readonly files = new Set<string>();
  dirs: string[] = [];
  home = '/home/tester';
  exists(path: string): boolean {
    return this.files.has(path);
  }
  pathDirs(): string[] {
    return [...this.dirs];
  }
  homeDir(): string {
    return this.home;
  }
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'blender-ws-'));
}

/** Runner+fs pair where Blender is "installed" at /usr/bin/blender via PATH. */
function installedSetup() {
  const runner = new FakeRunner();
  runner.whichResult = '/usr/bin/blender';
  const fs = new FakeFs();
  return { runner, fs };
}

// ---------------------------------------------------------------------------
// parseBlenderVersion
// ---------------------------------------------------------------------------

describe('parseBlenderVersion', () => {
  it('parses the first line of --version output', () => {
    expect(parseBlenderVersion('Blender 4.2.1\nBlender Foundation\n')).toBe('4.2.1');
    expect(parseBlenderVersion('Blender 3.6.5')).toBe('3.6.5');
    expect(parseBlenderVersion('no version here')).toBeUndefined();
    expect(parseBlenderVersion('')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectBlender
// ---------------------------------------------------------------------------

describe('detectBlender', () => {
  it('finds Blender on PATH (via which) and parses its version', async () => {
    const { runner, fs } = installedSetup();
    const det = await detectBlender(runner, 'linux', fs);
    expect(det.installed).toBe(true);
    expect(det.path).toBe('/usr/bin/blender');
    expect(det.version).toBe('4.2.1');
    expect(det.running).toBe(true);
    // Version was probed with the exact argv.
    expect(runner.calls[0]!.argv).toEqual(['/usr/bin/blender', '--version']);
  });

  it('finds Blender by scanning PATH dirs through the probe fs when which misses', async () => {
    const runner = new FakeRunner(); // which → undefined
    const fs = new FakeFs();
    fs.dirs = ['/opt/bin', '/usr/bin'];
    fs.files.add('/opt/bin/blender');
    const det = await detectBlender(runner, 'linux', fs);
    expect(det.installed).toBe(true);
    expect(det.path).toBe('/opt/bin/blender');
  });

  it('finds Blender in a common location (linux /usr/bin)', async () => {
    const runner = new FakeRunner();
    const fs = new FakeFs();
    fs.files.add('/usr/bin/blender');
    const det = await detectBlender(runner, 'linux', fs);
    expect(det.installed).toBe(true);
    expect(det.path).toBe('/usr/bin/blender');
  });

  it('finds Blender in a common location (darwin app bundle)', async () => {
    const runner = new FakeRunner();
    const fs = new FakeFs();
    fs.files.add('/Applications/Blender.app/Contents/MacOS/Blender');
    const det = await detectBlender(runner, 'darwin', fs);
    expect(det.installed).toBe(true);
    expect(det.path).toBe('/Applications/Blender.app/Contents/MacOS/Blender');
    expect(det.version).toBe('4.2.1');
  });

  it('finds Blender in a versioned Program Files dir (win32) and detects running via tasklist', async () => {
    const runner = new FakeRunner();
    const fs = new FakeFs();
    const exe = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe';
    fs.files.add(exe);
    const det = await detectBlender(runner, 'win32', fs);
    expect(det.installed).toBe(true);
    expect(det.path).toBe(exe);
    expect(det.running).toBe(true);
    expect(runner.calls.some((c) => c.argv[0] === 'tasklist')).toBe(true);
  });

  it('reports running=false when tasklist shows no blender.exe', async () => {
    const runner = new FakeRunner();
    runner.tasklistStdout = 'INFO: No tasks are running which match the specified criteria.\n';
    const fs = new FakeFs();
    fs.files.add('C:\\Program Files\\Blender Foundation\\blender.exe');
    const det = await detectBlender(runner, 'win32', fs);
    expect(det.installed).toBe(true);
    expect(det.running).toBe(false);
  });

  it('reports installed:false when Blender is absent', async () => {
    const det = await detectBlender(new FakeRunner(), 'linux', new FakeFs());
    expect(det.installed).toBe(false);
    expect(det.path).toBeUndefined();
    expect(det.detectionNote).toMatch(/not found/i);
  });

  it('reports running=false when pgrep finds no process (exit 1)', async () => {
    const { runner, fs } = installedSetup();
    runner.runningCode = 1;
    const det = await detectBlender(runner, 'linux', fs);
    expect(det.installed).toBe(true);
    expect(det.running).toBe(false);
  });

  it('omits running when the running check fails', async () => {
    const { runner, fs } = installedSetup();
    runner.failRunning = true;
    const det = await detectBlender(runner, 'linux', fs);
    expect(det.installed).toBe(true);
    expect(det.version).toBe('4.2.1');
    expect(det.running).toBeUndefined();
  });

  it('omits version (with a note) when --version output is unparsable', async () => {
    const { runner, fs } = installedSetup();
    runner.versionOutput = 'something unexpected\n';
    const det = await detectBlender(runner, 'linux', fs);
    expect(det.installed).toBe(true);
    expect(det.version).toBeUndefined();
    expect(det.detectionNote).toMatch(/version/i);
  });

  it('never throws, even when every probe fails', async () => {
    const runner = new FakeRunner();
    runner.whichError = new Error('which exploded');
    const throwingFs: BlenderProbeFs = {
      exists: () => {
        throw new Error('fs exploded');
      },
      pathDirs: () => {
        throw new Error('path exploded');
      },
      homeDir: () => '/home/tester',
    };
    const det = await detectBlender(runner, 'linux', throwingFs);
    expect(det.installed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertWorkspacePath / assertWorkspaceOutputPath
// ---------------------------------------------------------------------------

describe('assertWorkspacePath', () => {
  it('accepts paths inside a workspace root and resolves relatives against it', () => {
    const ws = workspace();
    expect(assertWorkspacePath(join(ws, 'scene.blend'), [ws])).toBe(join(ws, 'scene.blend'));
    expect(assertWorkspacePath('sub/scene.blend', [ws])).toBe(join(ws, 'sub/scene.blend'));
    expect(assertWorkspacePath(join(ws, 'a.py'), [ws], ['.py'])).toBe(join(ws, 'a.py'));
  });

  it('rejects paths outside every workspace root', () => {
    const ws = workspace();
    expect(() => assertWorkspacePath('/etc/passwd', [ws])).toThrow(/outside the workspace/);
    expect(() => assertWorkspacePath(join(ws, '..', 'escape.blend'), [ws])).toThrow(/outside the workspace/);
  });

  it('rejects the wrong extension', () => {
    const ws = workspace();
    expect(() => assertWorkspacePath(join(ws, 'script.py'), [ws], ['.blend'])).toThrow(/must have extension .blend/);
    expect(() => assertWorkspacePath(join(ws, 'scene.blend'), [ws], ['.py'])).toThrow(/must have extension .py/);
    expect(() => assertWorkspacePath(join(ws, 'noext'), [ws], ['.blend'])).toThrow(/must have extension/);
  });

  it('validates render output by its directory (prefix need not exist)', () => {
    const ws = workspace();
    expect(assertWorkspaceOutputPath(join(ws, 'renders/frame_'), [ws])).toBe(join(ws, 'renders/frame_'));
    expect(() => assertWorkspaceOutputPath('/tmp/evil/frame_', [ws])).toThrow(/outside the workspace/);
  });
});

// ---------------------------------------------------------------------------
// Policies + registration (mirrors composio-tools)
// ---------------------------------------------------------------------------

describe('blenderToolPolicies', () => {
  it('auto-allows status, approval-gates the three mutating tools', () => {
    const rules = blenderToolPolicies();
    const byPattern = new Map(rules.map((r) => [r.toolPattern, r.effect]));
    expect(byPattern.get('^blender_status$')).toBe('allow');
    expect(byPattern.get('^blender_open_file$')).toBe('require-approval');
    expect(byPattern.get('^blender_run_script$')).toBe('require-approval');
    expect(byPattern.get('^blender_render$')).toBe('require-approval');
  });
});

describe('registerBlenderTools', () => {
  it('registers all four tools and rejects collisions', () => {
    const ws = workspace();
    const { runner, fs } = installedSetup();
    const opts = { workspaceRoots: [ws], runner, probeFs: fs, platform: 'linux' as BlenderPlatform };
    const registry = new Map<string, ToolDefinition>();
    registerBlenderTools(registry, opts);
    expect([...registry.keys()].sort()).toEqual(
      [BLENDER_STATUS_TOOL, BLENDER_OPEN_FILE_TOOL, BLENDER_RUN_SCRIPT_TOOL, BLENDER_RENDER_TOOL].sort(),
    );
    expect(() => registerBlenderTools(registry, opts)).toThrow(/collision/);
  });

  it('marks the file/script/render tools as mutating, status as read-only', () => {
    const ws = workspace();
    const { runner, fs } = installedSetup();
    const registry = new Map<string, ToolDefinition>();
    registerBlenderTools(registry, { workspaceRoots: [ws], runner, probeFs: fs, platform: 'linux' });
    expect(registry.get(BLENDER_STATUS_TOOL)!.mutating).toBeFalsy();
    expect(registry.get(BLENDER_OPEN_FILE_TOOL)!.mutating).toBe(true);
    expect(registry.get(BLENDER_RUN_SCRIPT_TOOL)!.mutating).toBe(true);
    expect(registry.get(BLENDER_RENDER_TOOL)!.mutating).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// blender_status
// ---------------------------------------------------------------------------

describe('blender_status tool', () => {
  it('reports the detection result when Blender is installed', async () => {
    const ws = workspace();
    const { runner, fs } = installedSetup();
    const tool = createBlenderStatusTool({ workspaceRoots: [ws], runner, probeFs: fs, platform: 'linux' });
    const res = (await tool.handler({}, CTX)) as { installed: boolean; version?: string; path?: string };
    expect(res.installed).toBe(true);
    expect(res.path).toBe('/usr/bin/blender');
    expect(res.version).toBe('4.2.1');
  });

  it('reports installed:false instead of throwing when Blender is absent', async () => {
    const ws = workspace();
    const tool = createBlenderStatusTool({
      workspaceRoots: [ws],
      runner: new FakeRunner(),
      probeFs: new FakeFs(),
      platform: 'linux',
    });
    const res = (await tool.handler({}, CTX)) as { installed: boolean };
    expect(res.installed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// blender_open_file
// ---------------------------------------------------------------------------

describe('blender_open_file tool', () => {
  function setup() {
    const ws = workspace();
    const { runner, fs } = installedSetup();
    const launched: string[][] = [];
    const launchDetached = async (argv: string[]) => {
      launched.push([...argv]);
    };
    const tool = createBlenderOpenFileTool({
      workspaceRoots: [ws],
      runner,
      probeFs: fs,
      platform: 'linux',
      launchDetached,
    });
    return { ws, tool, launched, runner };
  }

  it('launches the GUI detached with [blender, file]', async () => {
    const { ws, tool, launched } = setup();
    const file = join(ws, 'scene.blend');
    const res = (await tool.handler({ file }, CTX)) as { opened: boolean; file: string };
    expect(res.opened).toBe(true);
    expect(res.file).toBe(file);
    expect(launched).toEqual([['/usr/bin/blender', file]]);
  });

  it('rejects files outside the workspace before launching anything', async () => {
    const { tool, launched } = setup();
    await expect(tool.handler({ file: '/etc/secret.blend' }, CTX)).rejects.toThrow(/outside the workspace/);
    expect(launched).toEqual([]);
  });

  it('rejects non-.blend files', async () => {
    const { ws, tool, launched } = setup();
    await expect(tool.handler({ file: join(ws, 'script.py') }, CTX)).rejects.toThrow(/must have extension .blend/);
    expect(launched).toEqual([]);
  });

  it('throws the clear not-installed error when Blender is absent', async () => {
    const ws = workspace();
    const tool = createBlenderOpenFileTool({
      workspaceRoots: [ws],
      runner: new FakeRunner(),
      probeFs: new FakeFs(),
      platform: 'linux',
      launchDetached: async () => {},
    });
    await expect(tool.handler({ file: join(ws, 'scene.blend') }, CTX)).rejects.toThrow(BLENDER_NOT_INSTALLED_ERROR);
  });
});

// ---------------------------------------------------------------------------
// blender_run_script
// ---------------------------------------------------------------------------

describe('blender_run_script tool', () => {
  function setup(extra: { timeoutMs?: number } = {}) {
    const ws = workspace();
    const { runner, fs } = installedSetup();
    const tool = createBlenderRunScriptTool({
      workspaceRoots: [ws],
      runner,
      probeFs: fs,
      platform: 'linux',
      ...extra,
    });
    return { ws, tool, runner };
  }

  it('builds the exact headless argv without a blend file', async () => {
    const { ws, tool, runner } = setup();
    const script = join(ws, 'do_thing.py');
    const res = (await tool.handler({ script }, CTX)) as { ok: boolean; code: number };
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(runner.backgroundCalls()).toEqual([
      ['/usr/bin/blender', '--background', '--python', script, '--python-exit-code', '1'],
    ]);
  });

  it('builds the exact headless argv with a blend file', async () => {
    const { ws, tool, runner } = setup();
    const script = join(ws, 'do_thing.py');
    const blendFile = join(ws, 'scene.blend');
    await tool.handler({ script, blendFile }, CTX);
    expect(runner.backgroundCalls()).toEqual([
      ['/usr/bin/blender', '--background', blendFile, '--python', script, '--python-exit-code', '1'],
    ]);
  });

  it('propagates a non-zero exit code as ok:false', async () => {
    const { ws, tool, runner } = setup();
    runner.runCode = 1;
    runner.runStderr = 'Traceback: boom';
    const res = (await tool.handler({ script: join(ws, 'x.py') }, CTX)) as {
      ok: boolean;
      code: number;
      stderr: string;
    };
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('boom');
  });

  it('propagates the configured timeout to the runner, clamped to 30 minutes', async () => {
    const a = setup({ timeoutMs: 123_456 });
    await a.tool.handler({ script: join(a.ws, 'x.py') }, CTX);
    const callA = a.runner.calls.find((c) => c.argv.includes('--background'))!;
    expect(callA.timeoutMs).toBe(123_456);

    const b = setup({ timeoutMs: 999_999_999 });
    await b.tool.handler({ script: join(b.ws, 'x.py') }, CTX);
    const callB = b.runner.calls.find((c) => c.argv.includes('--background'))!;
    expect(callB.timeoutMs).toBe(30 * 60 * 1000);

    const c = setup();
    await c.tool.handler({ script: join(c.ws, 'x.py') }, CTX);
    const callC = c.runner.calls.find((c) => c.argv.includes('--background'))!;
    expect(callC.timeoutMs).toBe(10 * 60 * 1000); // default 10 min
  });

  it('truncates oversized stdout/stderr at 8000 chars and notes it', async () => {
    const { ws, tool, runner } = setup();
    runner.runStdout = 'x'.repeat(20_000);
    runner.runStderr = 'y'.repeat(9_000);
    const res = (await tool.handler({ script: join(ws, 'x.py') }, CTX)) as {
      stdout: string;
      stderr: string;
      stdoutTruncated?: boolean;
      stderrTruncated?: boolean;
    };
    expect(res.stdout).toHaveLength(8000);
    expect(res.stderr).toHaveLength(8000);
    expect(res.stdoutTruncated).toBe(true);
    expect(res.stderrTruncated).toBe(true);
  });

  it('rejects scripts outside the workspace and non-.py scripts before running anything', async () => {
    const { ws, tool, runner } = setup();
    await expect(tool.handler({ script: '/tmp/evil.py' }, CTX)).rejects.toThrow(/outside the workspace/);
    await expect(tool.handler({ script: join(ws, 'scene.blend') }, CTX)).rejects.toThrow(/must have extension .py/);
    expect(runner.backgroundCalls()).toEqual([]);
  });

  it('throws the clear not-installed error when Blender is absent', async () => {
    const ws = workspace();
    const tool = createBlenderRunScriptTool({
      workspaceRoots: [ws],
      runner: new FakeRunner(),
      probeFs: new FakeFs(),
      platform: 'linux',
    });
    await expect(tool.handler({ script: join(ws, 'x.py') }, CTX)).rejects.toThrow(BLENDER_NOT_INSTALLED_ERROR);
  });
});

// ---------------------------------------------------------------------------
// blender_render
// ---------------------------------------------------------------------------

describe('blender_render tool', () => {
  function setup() {
    const ws = workspace();
    const { runner, fs } = installedSetup();
    const tool = createBlenderRenderTool({ workspaceRoots: [ws], runner, probeFs: fs, platform: 'linux' });
    return { ws, tool, runner };
  }

  it('builds the exact still-render argv (default frame 1) and reports the expected output', async () => {
    const { ws, tool, runner } = setup();
    const blendFile = join(ws, 'scene.blend');
    const outputPath = join(ws, 'renders/frame_');
    const res = (await tool.handler({ blendFile, outputPath }, CTX)) as {
      ok: boolean;
      outputs: string[];
      artifacts: Array<{ kind: string; path: string }>;
    };
    expect(res.ok).toBe(true);
    expect(runner.backgroundCalls()).toEqual([
      ['/usr/bin/blender', '--background', blendFile, '--render-output', outputPath, '--render-frame', '1'],
    ]);
    expect(res.outputs).toEqual([`${outputPath}0001.png`]);
    expect(res.artifacts).toEqual([{ kind: 'file', path: `${outputPath}0001.png` }]);
  });

  it('renders an explicit frame', async () => {
    const { ws, tool, runner } = setup();
    const blendFile = join(ws, 'scene.blend');
    const outputPath = join(ws, 'renders/frame_');
    const res = (await tool.handler({ blendFile, outputPath, frame: 24 }, CTX)) as { outputs: string[] };
    expect(runner.backgroundCalls()).toEqual([
      ['/usr/bin/blender', '--background', blendFile, '--render-output', outputPath, '--render-frame', '24'],
    ]);
    expect(res.outputs).toEqual([`${outputPath}0024.png`]);
  });

  it('builds the animation argv with --render-anim', async () => {
    const { ws, tool, runner } = setup();
    const blendFile = join(ws, 'scene.blend');
    const outputPath = join(ws, 'renders/anim_');
    const res = (await tool.handler({ blendFile, outputPath, animation: true }, CTX)) as {
      ok: boolean;
      outputs: string[];
      outputNote?: string;
    };
    expect(runner.backgroundCalls()).toEqual([
      ['/usr/bin/blender', '--background', blendFile, '--render-output', outputPath, '--render-anim'],
    ]);
    expect(res.outputs).toEqual([outputPath]);
    expect(res.outputNote).toMatch(/frame numbers/);
  });

  it('rejects an output path outside the workspace and a non-.blend input', async () => {
    const { ws, tool, runner } = setup();
    await expect(
      tool.handler({ blendFile: join(ws, 'scene.blend'), outputPath: '/tmp/evil/frame_' }, CTX),
    ).rejects.toThrow(/outside the workspace/);
    await expect(
      tool.handler({ blendFile: join(ws, 'script.py'), outputPath: join(ws, 'renders/frame_') }, CTX),
    ).rejects.toThrow(/must have extension .blend/);
    expect(runner.backgroundCalls()).toEqual([]);
  });

  it('reports ok:false on a non-zero render exit code', async () => {
    const { ws, tool, runner } = setup();
    runner.runCode = 2;
    const res = (await tool.handler(
      { blendFile: join(ws, 'scene.blend'), outputPath: join(ws, 'renders/frame_') },
      CTX,
    )) as { ok: boolean; code: number };
    expect(res.ok).toBe(false);
    expect(res.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// listLocalApps
// ---------------------------------------------------------------------------

describe('listLocalApps', () => {
  function probeWith(files: string[], dirs: string[]): LocalAppsProbe {
    const runner = new FakeRunner();
    runner.whichResult = '/usr/bin/blender';
    const fs = new FakeFs();
    fs.dirs = dirs;
    for (const f of files) fs.files.add(f);
    return { runner, probeFs: fs, platform: 'linux' };
  }

  it('returns the full catalog in order with the documented shape', async () => {
    const apps = await listLocalApps(probeWith([], []));
    expect(apps.map((a) => a.key)).toEqual([
      'blender',
      'whatsapp',
      'vscode',
      'spotify',
      'slack',
      'discord',
      'word',
      'excel',
      'powerpoint',
    ]);
    for (const app of apps) {
      expect(typeof app.name).toBe('string');
      expect(typeof app.installed).toBe('boolean');
      expect(typeof app.openName).toBe('string');
    }
    expect(apps.find((a) => a.key === 'vscode')!.openName).toBe('vscode');
  });

  it('gives Blender the full detection (version + running) and detects PATH apps', async () => {
    const apps = await listLocalApps(
      probeWith(['/usr/bin/code', '/usr/bin/spotify', '/usr/bin/slack'], ['/usr/bin']),
    );
    const blender = apps.find((a) => a.key === 'blender')!;
    expect(blender.installed).toBe(true);
    expect(blender.version).toBe('4.2.1');
    expect(blender.running).toBe(true);
    expect(blender.openName).toBe('blender');

    expect(apps.find((a) => a.key === 'vscode')!.installed).toBe(true);
    expect(apps.find((a) => a.key === 'spotify')!.installed).toBe(true);
    expect(apps.find((a) => a.key === 'slack')!.installed).toBe(true);
    expect(apps.find((a) => a.key === 'discord')!.installed).toBe(false);
  });

  it('is honest about best-effort detection for missing apps', async () => {
    const apps = await listLocalApps(probeWith([], []));
    const whatsapp = apps.find((a) => a.key === 'whatsapp')!;
    expect(whatsapp.installed).toBe(false);
    expect(whatsapp.detectionNote).toMatch(/best-effort/);
    // Office apps have no Linux binary in the alias map at all.
    const word = apps.find((a) => a.key === 'word')!;
    expect(word.installed).toBe(false);
    expect(word.detectionNote).toMatch(/No native linux install/);
  });

  it('detects macOS apps via /Applications bundles', async () => {
    const runner = new FakeRunner();
    const fs = new FakeFs();
    fs.files.add('/Applications/Blender.app/Contents/MacOS/Blender');
    fs.files.add('/Applications/WhatsApp.app');
    fs.files.add('/Applications/Microsoft Word.app');
    const apps = await listLocalApps({ runner, probeFs: fs, platform: 'darwin' });
    expect(apps.find((a) => a.key === 'blender')!.installed).toBe(true);
    expect(apps.find((a) => a.key === 'whatsapp')!.installed).toBe(true);
    expect(apps.find((a) => a.key === 'word')!.installed).toBe(true);
    expect(apps.find((a) => a.key === 'excel')!.installed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /local-apps route
// ---------------------------------------------------------------------------

describe('registerLocalAppRoutes', () => {
  let server: ReturnType<typeof express.application.listen> | undefined;
  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  it('serves GET /local-apps as { apps } using the injected probe', async () => {
    const runner = new FakeRunner();
    runner.whichResult = '/usr/bin/blender';
    const fs = new FakeFs();
    fs.dirs = ['/usr/bin'];
    fs.files.add('/usr/bin/code');
    const probe: LocalAppsProbe = { runner, probeFs: fs, platform: 'linux' };

    const config = {
      port: 0,
      dataDir: workspace(),
      seedDir: '',
      skillsDir: '',
      workspaceDir: '',
      webOutDir: '',
    } as AppConfig;

    const app = express();
    const router = express.Router();
    registerLocalAppRoutes(router, { config, probe });
    app.use('/api', router);
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/local-apps`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apps: Array<{ key: string; installed: boolean; openName: string }> };
    expect(body.apps).toHaveLength(9);
    expect(body.apps.find((a) => a.key === 'blender')!.installed).toBe(true);
    expect(body.apps.find((a) => a.key === 'vscode')!.installed).toBe(true);
    expect(body.apps.find((a) => a.key === 'vscode')!.openName).toBe('vscode');
  });
});
