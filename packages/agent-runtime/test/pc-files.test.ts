// SPDX-License-Identifier: Apache-2.0
// Tests for the PC file tools (tools/pc-files.ts + the grant-aware
// read_file in tools/builtin.ts):
// - workspace paths behave exactly as before (no host needed)
// - granted folders list/read without any approval card
// - ungranted paths raise the just-in-time card: allow-once sticks for
//   the session, always creates a bot-scoped grant, deny refuses
// - containment attacks fail: prefix sibling (Desktop2), .. traversal,
//   symlink escape out of a granted folder
// - per-bot grant scoping is honoured end to end

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PcAccessStore, type PcAccessHost } from '../src/pc-access.js';

type CardDecision = 'allow-once' | 'always' | 'deny';
import { createBuiltInTools } from '../src/tools/builtin.js';
import type { ToolContext, ToolDefinition } from '../src/types.js';

describe('PC file tools', () => {
  let dataDir: string;
  let store: PcAccessStore;
  let workspace: string;
  let pcRoot: string;
  let desktop: string;
  let tools: Map<string, ToolDefinition>;
  /** Scripted card decisions, consumed in order; default deny. */
  let script: CardDecision[];
  let cardsRaised: number;

  function makeHost(): PcAccessHost {
    return {
      grantedRoots: (botId) => store.grantsForBot(botId),
      isOnceAllowed: (sessionId, p) => store.isOnceAllowed(sessionId, p),
      requestAccess: async (input) => {
        cardsRaised += 1;
        const card = store.requestAccess(input);
        const decision = script.shift() ?? 'deny';
        store.decide(card.id, decision);
        return store.awaitOutcome(card.id, 5_000);
      },
    };
  }

  function ctx(botId = 'scout', sessionId = 'sess-1', withHost = true): ToolContext {
    return {
      sessionId,
      botId,
      ...(withHost ? { pcAccess: makeHost() } : {}),
    };
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'pc-tools-data-'));
    store = new PcAccessStore(dataDir);
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'pc-tools-ws-')));
    pcRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pc-tools-pc-')));
    desktop = join(pcRoot, 'Desktop');
    mkdirSync(desktop, { recursive: true });
    mkdirSync(join(pcRoot, 'Desktop2'), { recursive: true });
    writeFileSync(join(desktop, 'hello.txt'), 'hello from the desktop');
    writeFileSync(join(pcRoot, 'Desktop2', 'secret.txt'), 'prefix sibling secret');
    writeFileSync(join(pcRoot, 'outside.txt'), 'outside secret');
    writeFileSync(join(workspace, 'ws-note.txt'), 'workspace note');
    tools = new Map(
      createBuiltInTools({ workspaceDir: workspace }).map((t) => [t.name, t]),
    );
    script = [];
    cardsRaised = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(pcRoot, { recursive: true, force: true });
  });

  it('registers list_folder alongside read_file', () => {
    expect(tools.get('list_folder')).toBeDefined();
    expect(tools.get('read_file')).toBeDefined();
  });

  it('lists and reads inside the workspace with no host and no cards', async () => {
    const list = await tools.get('list_folder')!.handler({ path: '.' }, ctx('scout', 's', false));
    expect(list).toMatchObject({ scope: 'workspace' });
    const read = await tools
      .get('read_file')!
      .handler({ path: 'ws-note.txt' }, ctx('scout', 's', false));
    expect(read).toBe('workspace note');
  });

  it('lists a granted folder without raising a card', async () => {
    store.addGrant({ path: desktop, createdVia: 'settings' });
    const out = await tools.get('list_folder')!.handler({ path: desktop }, ctx());
    expect(out).toMatchObject({ scope: 'pc', accessVia: 'grant', path: desktop });
    expect((out as { entries: unknown[] }).entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'hello.txt', type: 'file' })]),
    );
    expect(cardsRaised).toBe(0);
  });

  it('reads a file in a granted folder without raising a card', async () => {
    store.addGrant({ path: desktop, createdVia: 'settings' });
    const out = await tools
      .get('read_file')!
      .handler({ path: join(desktop, 'hello.txt') }, ctx());
    expect(out).toBe('hello from the desktop');
    expect(cardsRaised).toBe(0);
  });

  it('JIT deny: ungranted list/read refuse with the denial reason', async () => {
    script = ['deny'];
    await expect(tools.get('list_folder')!.handler({ path: desktop }, ctx())).rejects.toThrow(
      /denied access/i,
    );
    script = ['deny'];
    await expect(
      tools.get('read_file')!.handler({ path: join(desktop, 'hello.txt') }, ctx()),
    ).rejects.toThrow(/denied access/i);
  });

  it('JIT allow-once: works now and for the rest of the session, no second card', async () => {
    script = ['allow-once'];
    const out = await tools.get('list_folder')!.handler({ path: desktop }, ctx());
    expect(out).toMatchObject({ scope: 'pc' });
    expect(cardsRaised).toBe(1);
    // Same session: reading a file inside needs no new card.
    const read = await tools
      .get('read_file')!
      .handler({ path: join(desktop, 'hello.txt') }, ctx());
    expect(read).toBe('hello from the desktop');
    expect(cardsRaised).toBe(1);
    expect(store.listGrants()).toHaveLength(0); // allow-once persists nothing
    // A different session asks again.
    script = ['deny'];
    await expect(
      tools.get('list_folder')!.handler({ path: desktop }, ctx('scout', 'sess-2')),
    ).rejects.toThrow(/denied access/i);
    expect(cardsRaised).toBe(2);
  });

  it('JIT always: creates a bot-scoped grant; other bots still have to ask', async () => {
    script = ['always'];
    await tools.get('list_folder')!.handler({ path: desktop }, ctx('scout'));
    expect(store.listGrants()).toHaveLength(1);
    expect(store.listGrants()[0]).toMatchObject({ scope: 'scout', createdVia: 'approval' });
    // Scout again: no card.
    await tools.get('list_folder')!.handler({ path: desktop }, ctx('scout', 'sess-9'));
    expect(cardsRaised).toBe(1);
    // Coder: the grant is not his — a card is raised (scripted deny).
    script = ['deny'];
    await expect(
      tools.get('list_folder')!.handler({ path: desktop }, ctx('coder')),
    ).rejects.toThrow(/denied access/i);
    expect(cardsRaised).toBe(2);
  });

  it('per-bot grant in Settings is honoured: coder-only grant does not cover scout', async () => {
    store.addGrant({ path: desktop, botId: 'coder', createdVia: 'settings' });
    const out = await tools.get('list_folder')!.handler({ path: desktop }, ctx('coder'));
    expect(out).toMatchObject({ scope: 'pc' });
    expect(cardsRaised).toBe(0);
    script = ['deny'];
    await expect(tools.get('list_folder')!.handler({ path: desktop }, ctx('scout'))).rejects.toThrow(
      /denied access/i,
    );
  });

  it('prefix trick: a Desktop grant never covers Desktop2', async () => {
    store.addGrant({ path: desktop, createdVia: 'settings' });
    script = ['deny'];
    await expect(
      tools.get('read_file')!.handler({ path: join(pcRoot, 'Desktop2', 'secret.txt') }, ctx()),
    ).rejects.toThrow(/denied access/i);
    // The JIT card WAS raised (nothing was silently allowed) — and denial held.
    expect(cardsRaised).toBe(1);
  });

  it('.. traversal out of a granted folder is re-canonicalized and refused', async () => {
    store.addGrant({ path: desktop, createdVia: 'settings' });
    script = ['deny'];
    await expect(
      tools.get('read_file')!.handler({ path: join(desktop, '..', 'outside.txt') }, ctx()),
    ).rejects.toThrow(/denied access/i);
    expect(cardsRaised).toBe(1);
  });

  it('symlink inside a granted folder pointing outside does not leak', async () => {
    store.addGrant({ path: desktop, createdVia: 'settings' });
    symlinkSync(join(pcRoot, 'outside.txt'), join(desktop, 'escape.txt'));
    script = ['deny'];
    await expect(
      tools.get('read_file')!.handler({ path: join(desktop, 'escape.txt') }, ctx()),
    ).rejects.toThrow(/denied access/i);
  });

  it('no host attached: absolute PC paths keep the old workspace fence error', async () => {
    store.addGrant({ path: desktop, createdVia: 'settings' });
    await expect(
      tools.get('read_file')!.handler({ path: join(desktop, 'hello.txt') }, ctx('scout', 's', false)),
    ).rejects.toThrow(/escapes workspace/);
    await expect(
      tools.get('list_folder')!.handler({ path: desktop }, ctx('scout', 's', false)),
    ).rejects.toThrow(/not attached|escapes/i);
  });

  it('list_folder on a granted FILE path reports not-a-folder', async () => {
    store.addGrant({ path: desktop, createdVia: 'settings' });
    await expect(
      tools.get('list_folder')!.handler({ path: join(desktop, 'hello.txt') }, ctx()),
    ).rejects.toThrow(/not a folder/);
  });
});
