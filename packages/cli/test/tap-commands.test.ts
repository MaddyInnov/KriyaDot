// SPDX-License-Identifier: Apache-2.0
// Tests for tap-commands.ts (`kriyadot tap …`, #157/#103): init runs the
// real @mvp/marketplace scaffold → validate → register round-trip in a
// temp dir; install is driven through injected TapRuntime paths and a
// FAKE fetcher (no network). Dispatch through runCommand is covered too.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MarketplaceRegistry,
  loadTapChannels,
  saveTapChannel,
  validatePackage,
} from '@mvp/marketplace';
import { parseArgs, validateCommand } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { runTapCommand } from '../src/tap-commands.js';
import type { TapRuntime } from '../src/tap-commands.js';
import { EXIT_ERROR, EXIT_USAGE } from '../src/exits.js';
import { makeDeps, makeFakeApi } from './fake-api.js';

function skillEntry(id: string): Record<string, unknown> {
  return {
    id,
    kind: 'skill',
    name: id,
    version: '1.0.0',
    creator: 'test',
    description: `${id} desc`,
    license: 'Apache-2.0',
    priceCents: 0,
    tags: [],
    untrusted: false,
    payload: { id, content: `# ${id}\n` },
  };
}

describe('tap commands', () => {
  let dir: string;
  let rt: TapRuntime;
  let fetchedUrls: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kriyadot-tap-'));
    fetchedUrls = [];
    rt = {
      registryPath: join(dir, 'state', 'marketplace-registry.json'),
      channelsPath: join(dir, 'state', 'taps.json'),
      installDir: join(dir, 'state', 'marketplace'),
      fetcher: async (url: string) => {
        fetchedUrls.push(url);
        return JSON.stringify({ name: 'acme', entries: [skillEntry('tap-skill')] });
      },
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('init scaffolds, validates and registers a bot package (round-trip)', async () => {
    const deps = makeDeps(makeFakeApi({}));
    const code = await runTapCommand(
      parseArgs(['tap', 'init', join(dir, 'pkgs'), '--kind', 'bot', '--id', 'my-bot', '--name', 'My Bot', '--description', 'Does bot things.']),
      deps,
      rt,
    );
    expect(code).toBe(0);
    const pkgDir = join(dir, 'pkgs', 'my-bot');
    expect(existsSync(join(pkgDir, 'manifest.json'))).toBe(true);
    expect(validatePackage(pkgDir)).toMatchObject({ valid: true, kind: 'bot', id: 'my-bot' });
    const registry = MarketplaceRegistry.fromFile(rt.registryPath!);
    expect(registry.getById('my-bot')?.kind).toBe('bot');
    expect(deps.stdoutText()).toContain('registered in the local registry');
  });

  it('init with --format json reports the scaffold + registration', async () => {
    const deps = makeDeps(makeFakeApi({}));
    const p = parseArgs(['tap', 'init', join(dir, 'pkgs'), '--kind', 'skill', '--id', 'my-skill', '--format', 'json']);
    // --format is a global flag consumed by parseArgs' global table.
    const code = await runTapCommand(p, deps, rt);
    expect(code).toBe(0);
    const parsed = JSON.parse(deps.stdoutText()) as { ok: boolean; validation: { valid: boolean }; registered: { id: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.validation.valid).toBe(true);
    expect(parsed.registered.id).toBe('my-skill');
  });

  it('init for kind tap registers a named local channel', async () => {
    const deps = makeDeps(makeFakeApi({}));
    const code = await runTapCommand(
      parseArgs(['tap', 'init', join(dir, 'taps'), '--kind', 'tap', '--id', 'my-tap', '--name', 'My Tap']),
      deps,
      rt,
    );
    expect(code).toBe(0);
    expect(loadTapChannels(rt.channelsPath!)['my-tap']).toEqual({
      type: 'local',
      path: join(dir, 'taps', 'my-tap'),
    });
    expect(deps.stdoutText()).toContain('tap channel "my-tap"');
  });

  it('init --no-register scaffolds without touching the registry', async () => {
    const deps = makeDeps(makeFakeApi({}));
    const code = await runTapCommand(
      parseArgs(['tap', 'init', join(dir, 'pkgs'), '--kind', 'workflow', '--id', 'my-flow', '--no-register']),
      deps,
      rt,
    );
    expect(code).toBe(0);
    expect(existsSync(rt.registryPath!)).toBe(false);
    expect(validatePackage(join(dir, 'pkgs', 'my-flow')).valid).toBe(true);
  });

  it('init rejects a bad kind and a missing kind/dir as usage errors', async () => {
    const deps = makeDeps(makeFakeApi({}));
    expect(await runTapCommand(parseArgs(['tap', 'init', join(dir, 'x'), '--kind', 'widget', '--id', 'w']), deps, rt)).toBe(EXIT_USAGE);
    expect(await runTapCommand(parseArgs(['tap', 'init', join(dir, 'x')]), deps, rt)).toBe(EXIT_USAGE);
    expect(await runTapCommand(parseArgs(['tap', 'init', '--kind', 'bot', '--id', 'w']), deps, rt)).toBe(EXIT_USAGE);
  });

  it('validate reports a scaffolded package and fails an empty dir', async () => {
    const deps = makeDeps(makeFakeApi({}));
    await runTapCommand(parseArgs(['tap', 'init', join(dir, 'pkgs'), '--kind', 'bot', '--id', 'v-bot', '--no-register']), deps, rt);
    const okDeps = makeDeps(makeFakeApi({}));
    expect(await runTapCommand(parseArgs(['tap', 'validate', join(dir, 'pkgs', 'v-bot')]), okDeps, rt)).toBe(0);
    expect(okDeps.stdoutText()).toContain('Valid bot package "v-bot"');
    const badDeps = makeDeps(makeFakeApi({}));
    mkdirSync(join(dir, 'empty'), { recursive: true });
    expect(await runTapCommand(parseArgs(['tap', 'validate', join(dir, 'empty')]), badDeps, rt)).toBe(EXIT_ERROR);
  });

  it('install github: ref fetches the raw manifest via the injected fetcher and installs', async () => {
    const deps = makeDeps(makeFakeApi({}));
    const code = await runTapCommand(parseArgs(['tap', 'install', 'github:acme/taps']), deps, rt);
    expect(code).toBe(0);
    expect(fetchedUrls).toEqual(['https://raw.githubusercontent.com/acme/taps/main/marketplace.json']);
    expect(existsSync(join(dir, 'state', 'marketplace', 'installed', 'skills', 'tap-skill.md'))).toBe(true);
    expect(deps.stdoutText()).toContain('tap-skill');
  });

  it('install local: ref and bare path install from a local tap dir without fetching', async () => {
    const tapDir = join(dir, 'local-tap');
    mkdirSync(tapDir, { recursive: true });
    writeFileSync(join(tapDir, 'tap.json'), JSON.stringify({ name: 'local', entries: [skillEntry('local-skill')] }));
    for (const ref of [`local:${tapDir}`, tapDir]) {
      const deps = makeDeps(makeFakeApi({}));
      const code = await runTapCommand(parseArgs(['tap', 'install', ref, '--overwrite']), deps, rt);
      expect(code).toBe(0);
      expect(deps.stdoutText()).toContain('local-skill');
    }
    expect(fetchedUrls).toEqual([]);
    expect(existsSync(join(dir, 'state', 'marketplace', 'installed', 'skills', 'local-skill.md'))).toBe(true);
  });

  it('install channel: ref resolves through the channels file', async () => {
    const tapDir = join(dir, 'chan-tap');
    mkdirSync(tapDir, { recursive: true });
    writeFileSync(join(tapDir, 'tap.json'), JSON.stringify({ entries: [skillEntry('chan-skill')] }));
    saveTapChannel(rt.channelsPath!, 'my-chan', { type: 'local', path: tapDir });
    const deps = makeDeps(makeFakeApi({}));
    const code = await runTapCommand(parseArgs(['tap', 'install', 'channel:my-chan']), deps, rt);
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'state', 'marketplace', 'installed', 'skills', 'chan-skill.md'))).toBe(true);
    expect(fetchedUrls).toEqual([]);
  });

  it('install of an unknown channel is an error, not a silent no-op', async () => {
    const deps = makeDeps(makeFakeApi({}));
    const code = await runTapCommand(parseArgs(['tap', 'install', 'channel:nope']), deps, rt);
    expect(code).toBe(EXIT_ERROR);
    expect(deps.stderrText()).toContain('unknown tap channel "nope"');
  });

  it('bare tap prints help; unknown subcommand is a usage error', async () => {
    const deps = makeDeps(makeFakeApi({}));
    expect(await runTapCommand(parseArgs(['tap']), deps, rt)).toBe(0);
    expect(deps.stdoutText()).toContain('tap install');
    expect(await runTapCommand(parseArgs(['tap', 'bogus']), deps, rt)).toBe(EXIT_USAGE);
  });

  it('is dispatched through runCommand and passes validateCommand', async () => {
    expect(validateCommand(parseArgs(['tap', 'init', 'somedir', '--kind', 'bot']))).toBeNull();
    expect(validateCommand(parseArgs(['tap', 'install']))).toMatch(/tap install/);
    const deps = makeDeps(makeFakeApi({}));
    // validate against a nonexistent dir exercises the full dispatch path
    // (runCommand → runTapCommand) without touching real config state.
    const code = await runCommand(parseArgs(['tap', 'validate', join(dir, 'missing')]), deps);
    expect(code).toBe(EXIT_ERROR);
    expect(deps.stderrText()).toContain('Invalid package');
    const registryText = existsSync(rt.registryPath!) ? readFileSync(rt.registryPath!, 'utf8') : '';
    expect(registryText).toBe('');
  });
});
