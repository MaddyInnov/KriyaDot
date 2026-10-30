// SPDX-License-Identifier: Apache-2.0
// Wave-3 worker tests: CA-2 (approval modes), CA-6 (/init generator),
// CA-7/CA-8 (project instructions), CA-16 (skill mechanics),
// CA-37 (incognito sessions).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyApprovalMode,
  isSafeFilesystemCommand,
  nativeCliPermissionMode,
  parseApprovalMode,
} from '../src/approval-modes.js';
import { analyzeWorkspace, generateInitInstructions } from '../src/init-generator.js';
import {
  clearProjectInstructionsCache,
  expandInstructionImports,
  loadProjectInstructions,
  matchPathGlob,
} from '../src/project-instructions.js';
import { SkillLoader, prepareSkillExecution } from '../src/skills.js';
import { SessionStore, sessionAllowsMemoryWrite } from '../src/sessions.js';
import { expandShellInjections } from '../src/dynamic-context.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ca-wave3-'));
  clearProjectInstructionsCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearProjectInstructionsCache();
});

describe('CA-2 approval mode matrix', () => {
  it('parses the two new modes', () => {
    expect(parseApprovalMode('acceptEdits')).toBe('acceptEdits');
    expect(parseApprovalMode('dontAsk')).toBe('dontAsk');
  });

  it('acceptEdits upgrades prompts only for file edits + safe fs commands', () => {
    const edit = { name: 'write_file', mutating: true, args: { path: 'a.txt' } };
    expect(applyApprovalMode('acceptEdits', 'require-approval', edit).decision).toBe('allow');
    expect(applyApprovalMode('acceptEdits', 'require-approval', { name: 'edit_file', args: {} }).decision).toBe('allow');
    expect(applyApprovalMode('acceptEdits', 'require-approval', { name: 'run_command', args: { command: 'mkdir src' } }).decision).toBe('allow');
    expect(applyApprovalMode('acceptEdits', 'require-approval', { name: 'run_command', args: { command: 'ls -la' } }).decision).toBe('allow');
    // Unsafe / unrelated calls still prompt.
    expect(applyApprovalMode('acceptEdits', 'require-approval', { name: 'run_command', args: { command: 'npm install' } }).decision).toBe('require-approval');
    expect(applyApprovalMode('acceptEdits', 'require-approval', { name: 'run_command', args: { command: 'ls; rm x' } }).decision).toBe('require-approval');
    expect(applyApprovalMode('acceptEdits', 'require-approval', { name: 'send_email', args: {} }).decision).toBe('require-approval');
    // Explicit allows pass through.
    expect(applyApprovalMode('acceptEdits', 'allow', edit).decision).toBe('allow');
  });

  it('dontAsk denies anything that would prompt; explicit allows still work', () => {
    expect(applyApprovalMode('dontAsk', 'require-approval', { name: 'write_file', args: {} }).decision).toBe('deny');
    expect(applyApprovalMode('dontAsk', 'require-approval', { name: 'read_file', args: {} }).decision).toBe('deny');
    expect(applyApprovalMode('dontAsk', 'allow', { name: 'read_file', args: {} }).decision).toBe('allow');
  });

  it('no mode ever upgrades a governance deny', () => {
    for (const mode of ['plan', 'auto', 'bypass', 'acceptEdits', 'dontAsk'] as const) {
      expect(applyApprovalMode(mode, 'deny', { name: 'write_file', args: {} }).decision).toBe('deny');
    }
  });

  it('safe fs command screen rejects chaining/substitution', () => {
    expect(isSafeFilesystemCommand('git status')).toBe(true);
    expect(isSafeFilesystemCommand('cp a.txt b.txt')).toBe(true);
    expect(isSafeFilesystemCommand('ls $(pwd)')).toBe(false);
    expect(isSafeFilesystemCommand('cat a | grep x')).toBe(false);
    expect(isSafeFilesystemCommand('mv a b && rm b')).toBe(false);
    expect(isSafeFilesystemCommand('curl example.com')).toBe(false);
  });

  it('native CLI mapping carries the new modes', () => {
    expect(nativeCliPermissionMode('acceptEdits', 'claude-code')).toBe('acceptEdits');
    expect(nativeCliPermissionMode('dontAsk', 'claude-code')).toBe('dontAsk');
    expect(nativeCliPermissionMode('dontAsk', 'codex')).toBe('workspace-write');
  });
});

describe('CA-6 init generator', () => {
  it('detects commands/layout from a fixture repo', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-app', scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .' } }));
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {};');
    const { analysis, content, fileName } = generateInitInstructions(dir);
    expect(fileName).toBe('AGENTS.md');
    expect(analysis.languages).toContain('JavaScript/TypeScript');
    expect(analysis.commands.build).toBe('npm run build');
    expect(analysis.commands.test).toBe('npm run test');
    expect(analysis.layout).toContain('src/');
    expect(content).toContain('# fixture-app');
    expect(content).toContain('`npm run test`');
  });

  it('detects Rust + Makefile and reports existing instruction files', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname="x"');
    writeFileSync(join(dir, 'Makefile'), 'build:\n\tcargo build\n');
    writeFileSync(join(dir, 'AGENTS.md'), 'existing');
    const a = analyzeWorkspace(dir);
    expect(a.languages).toContain('Rust');
    expect(a.commands.test).toBe('cargo test');
    expect(a.existingInstructionFiles).toEqual(['AGENTS.md']);
  });

  it('never invents commands for an empty repo', () => {
    const { content, analysis } = generateInitInstructions(dir);
    expect(analysis.commands).toEqual({});
    expect(content).toContain('<fill in the command');
  });
});

describe('CA-7/CA-8 project instructions', () => {
  it('matchPathGlob handles **, *, ?', () => {
    expect(matchPathGlob('src/**/*.ts', 'src/a/b.ts')).toBe(true);
    expect(matchPathGlob('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(matchPathGlob('**/*.md', 'docs/x.md')).toBe(true);
    expect(matchPathGlob('src/?.ts', 'src/a.ts')).toBe(true);
  });

  it('merges global → workspace → path-scoped, most specific last', () => {
    const globalDir = join(dir, 'globalcfg');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'instructions.md'), 'GLOBAL RULE');
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, '.kriyadot', 'rules'), { recursive: true });
    writeFileSync(join(ws, 'AGENTS.md'), 'WORKSPACE RULE');
    writeFileSync(join(ws, '.kriyadot', 'rules', 'ts.md'), '---\npaths: ["src/**/*.ts"]\n---\nTS RULE');
    writeFileSync(join(ws, '.kriyadot', 'rules', 'py.md'), '---\npaths: ["**/*.py"]\n---\nPY RULE');
    const loaded = loadProjectInstructions(ws, { globalDir, touchedPaths: ['src/app.ts'] })!;
    expect(loaded.text.indexOf('GLOBAL RULE')).toBeLessThan(loaded.text.indexOf('WORKSPACE RULE'));
    expect(loaded.text.indexOf('WORKSPACE RULE')).toBeLessThan(loaded.text.indexOf('TS RULE'));
    expect(loaded.text).not.toContain('PY RULE');
    expect(loaded.files).toContain('global:instructions.md');
  });

  it('derives touched paths from the user message', () => {
    const ws = join(dir, 'ws2');
    mkdirSync(join(ws, '.kriyadot', 'rules'), { recursive: true });
    writeFileSync(join(ws, '.kriyadot', 'rules', 'py.md'), '---\npaths:\n  - "**/*.py"\n---\nPY RULE');
    const loaded = loadProjectInstructions(ws, { globalDir: false, message: 'please fix scripts/train.py today' })!;
    expect(loaded.text).toContain('PY RULE');
    const other = loadProjectInstructions(ws, { globalDir: false, message: 'hello there' });
    expect(other).toBeUndefined();
  });

  it('loads configured instruction sources from .kriyadot/config.json', () => {
    const ws = join(dir, 'ws3');
    mkdirSync(join(ws, '.kriyadot'), { recursive: true });
    mkdirSync(join(ws, 'docs'));
    writeFileSync(join(ws, 'docs', 'guide.md'), 'GUIDE RULE');
    writeFileSync(join(ws, '.kriyadot', 'config.json'), JSON.stringify({ instructions: ['docs/*.md'] }));
    const loaded = loadProjectInstructions(ws, { globalDir: false })!;
    expect(loaded.text).toContain('GUIDE RULE');
    expect(loaded.files).toContain('docs/guide.md');
  });

  it('@imports inline, are depth-capped and escape-safe', () => {
    const ws = join(dir, 'ws4');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'extra.md'), 'EXTRA CONTENT');
    writeFileSync(join(ws, 'AGENTS.md'), 'Top.\n@extra.md\nBottom.');
    const loaded = loadProjectInstructions(ws, { globalDir: false })!;
    expect(loaded.text).toContain('EXTRA CONTENT');
    const escaped = expandInstructionImports('@../outside.md', ws, [ws]);
    expect(escaped).toContain('import refused');
    // Cycles are refused, and long acyclic chains hit the depth cap.
    writeFileSync(join(ws, 'loop.md'), 'loop @loop.md');
    expect(expandInstructionImports('@loop.md', ws, [ws])).toContain('cycle');
    writeFileSync(join(ws, 'a.md'), 'A @b.md');
    writeFileSync(join(ws, 'b.md'), 'B @c.md');
    writeFileSync(join(ws, 'c.md'), 'C @d.md');
    writeFileSync(join(ws, 'd.md'), 'D @e.md');
    writeFileSync(join(ws, 'e.md'), 'E');
    expect(expandInstructionImports('@a.md', ws, [ws])).toContain('depth limit');
  });
});

describe('CA-16 skill mechanics', () => {
  function skillsDir(): string {
    const d = join(dir, 'skills');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'useronly.md'), '---\nname: useronly\ndescription: u\ninvocation: user\nactivation:\n  keywords: [deploy]\n---\nUser only body.');
    writeFileSync(join(d, 'auto.md'), '---\nname: auto\ndescription: a\nactivation:\n  keywords: [deploy]\n---\nAuto body.');
    writeFileSync(join(d, 'forked.md'), '---\nname: forked\ndescription: f\ncontext: fork\n---\nFork body.');
    writeFileSync(join(d, 'dyn.md'), '---\nname: dyn\ndescription: d\n---\nToday: !`date +%F`');
    writeFileSync(join(d, 'legacy.md'), '---\nname: legacy\ndescription: l\ndisable-model-invocation: true\n---\nLegacy body.');
    return d;
  }

  it('invocation control: user-only skills never auto-activate', async () => {
    const loader = new SkillLoader(skillsDir());
    expect(loader.canModelInvoke('useronly')).toBe(false);
    expect(loader.canUserInvoke('useronly')).toBe(true);
    expect(loader.canModelInvoke('legacy')).toBe(false); // disable-model-invocation alias
    expect(loader.skillsMatchingMessage('please deploy now')).toEqual(['auto']);
    expect(loader.filterModelInvocable(['useronly', 'auto'])).toEqual(['auto']);
    const loaded = await loader.loadFull('useronly');
    expect(loaded.invocation).toBe('user');
  });

  it('fork context prepares a delegate task; inline does not', async () => {
    const loader = new SkillLoader(skillsDir());
    const forked = await loader.loadFull('forked');
    const prep = prepareSkillExecution(forked, 'do the thing');
    expect(prep.mode).toBe('fork');
    expect(prep.delegateTask).toContain('in isolation');
    expect(prep.delegateTask).toContain('do the thing');
    const inline = prepareSkillExecution(await loader.loadFull('auto'), 'x');
    expect(inline.mode).toBe('inline');
    expect(inline.delegateTask).toBeUndefined();
  });

  it('dynamic context injection is governance-gated', async () => {
    const denied = new SkillLoader(skillsDir(), {
      dynamicContext: { gate: () => 'deny', runner: () => 'SHOULD-NOT-RUN' },
    });
    expect((await denied.loadFull('dyn')).content).toContain('denied by governance');
    const allowed = new SkillLoader(skillsDir(), {
      dynamicContext: { gate: () => 'allow', runner: () => '2026-10-30' },
    });
    expect((await allowed.loadFull('dyn')).content).toContain('2026-10-30');
    const unwired = new SkillLoader(skillsDir());
    expect((await unwired.loadFull('dyn')).content).toContain('not run');
  });

  it('expandShellInjections treats require-approval as not approved', async () => {
    const out = await expandShellInjections('a !`ls` b', { gate: () => 'require-approval', runner: () => 'X' });
    expect(out).toContain('denied by governance');
    expect(out).not.toContain('X');
  });
});

describe('CA-37 incognito sessions', () => {
  it('keeps messages in memory only; a reopened store sees none', async () => {
    const dbPath = join(dir, 'sessions.db');
    const store = new SessionStore(dbPath);
    const id = store.createSession('bot-a', { incognito: true });
    store.appendMessage(id, { role: 'user', content: 'secret q' });
    store.appendMessage(id, { role: 'assistant', content: 'secret a' });
    expect(store.isIncognitoSession(id)).toBe(true);
    expect(store.listThreadMessages(id).map((m) => m.content)).toEqual(['secret q', 'secret a']);
    expect((await store.getMessages(id)).map((m) => m.content)).toEqual(['secret q', 'secret a']);
    expect(store.searchMessages('secret')).toEqual([]);
    const summary = store.listSessions().find((s) => s.id === id)!;
    expect(summary.incognito).toBe(true);
    expect(summary.messageCount).toBe(2);
    expect(sessionAllowsMemoryWrite(store.getSession(id))).toBe(false);
    store.close();
    // Reopen: the row + flag survive, the content does not.
    const store2 = new SessionStore(dbPath);
    expect(store2.getSession(id)?.incognito).toBe(true);
    expect(store2.listThreadMessages(id)).toEqual([]);
    expect(existsSync(dbPath)).toBe(true);
    // Close removes the row too.
    expect(store2.closeIncognitoSession(id)).toBe(true);
    expect(store2.getSession(id)).toBeUndefined();
    store2.close();
  });

  it('normal sessions still persist and allow memory writes', async () => {
    const store = new SessionStore(join(dir, 'normal.db'));
    const id = store.createSession('bot-a');
    store.appendMessage(id, { role: 'user', content: 'hello' });
    expect(store.isIncognitoSession(id)).toBe(false);
    expect(sessionAllowsMemoryWrite(store.getSession(id))).toBe(true);
    expect(store.listThreadMessages(id)).toHaveLength(1);
    expect(store.closeIncognitoSession(id)).toBe(false);
    store.close();
  });

  it('branching an incognito thread keeps the branch incognito', () => {
    const store = new SessionStore(join(dir, 'branch.db'));
    const id = store.createSession('bot-a', { incognito: true });
    store.appendMessage(id, { role: 'user', content: 'q1' });
    store.appendMessage(id, { role: 'assistant', content: 'a1' });
    const msgId = store.listThreadMessages(id)[0]!.id;
    const res = store.branchSession(id, msgId);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.session.incognito).toBe(true);
      expect(store.listThreadMessages(res.session.id).map((m) => m.content)).toEqual(['q1']);
    }
    store.close();
  });
});
