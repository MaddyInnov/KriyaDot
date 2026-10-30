// SPDX-License-Identifier: Apache-2.0
// CA-4 / CA-30 / CA-28 (CLI): checkpoint diff aggregation + formatting,
// /rewind and /diff in the REPL, and terminal-signal emission.

import { describe, expect, it } from 'vitest';
import {
  aggregateCheckpointDiff,
  diffLineCounts,
  formatCheckpointList,
  formatSessionDiff,
  type CheckpointLike,
} from '../src/checkpoints.js';
import { emitTerminalSignal, resolveNotifyMode, signalSequence } from '../src/terminal-signals.js';
import { runRepl } from '../src/repl.js';
import { makeDeps, makeFakeApi, makeFakeLines } from './fake-api.js';

const CPS: CheckpointLike[] = [
  { id: 'cp-1111', sessionId: 's1', createdAt: 1000, files: { 'src/a.ts': 'one\ntwo' }, historyLength: 0, label: 'before write_file src/a.ts' },
  { id: 'cp-2222', sessionId: 's1', createdAt: 2000, files: { 'src/a.ts': 'one\ntwo\nthree', 'src/b.ts': null }, historyLength: 2, label: 'before patch' },
];

describe('aggregateCheckpointDiff', () => {
  it('uses readCurrent when provided (created/modified, unchanged omitted)', () => {
    const current = new Map<string, string | null>([
      ['src/a.ts', 'one\nTWO\nthree'],
      ['src/b.ts', 'new file'],
    ]);
    const rows = aggregateCheckpointDiff(CPS, (p) => current.get(p));
    expect(rows).toEqual([
      { path: 'src/a.ts', status: 'modified', added: 2, removed: 1, touches: 2 },
      { path: 'src/b.ts', status: 'created', added: 1, removed: 0, touches: 1 },
    ]);
  });

  it('falls back to snapshot-to-snapshot comparison without readCurrent', () => {
    const rows = aggregateCheckpointDiff(CPS);
    const a = rows.find((r) => r.path === 'src/a.ts');
    expect(a?.status).toBe('changed');
    expect(a?.added).toBe(1); // 'three' appears between first and last snapshot
    expect(rows.find((r) => r.path === 'src/b.ts')?.status).toBe('changed');
  });

  it('diffLineCounts matches LCS expectations', () => {
    expect(diffLineCounts('a\nb', 'a\nc')).toEqual({ added: 1, removed: 1 });
    expect(diffLineCounts(null, null)).toEqual({ added: 0, removed: 0 });
  });

  it('formatters render lists and empty states', () => {
    expect(formatCheckpointList([])).toContain('no checkpoints');
    const list = formatCheckpointList(CPS);
    expect(list).toContain('src/a.ts');
    expect(list).toContain('/rewind <n>');
    expect(formatSessionDiff([])).toContain('no file changes');
    expect(formatSessionDiff(aggregateCheckpointDiff(CPS, () => 'x'))).toContain('session changes');
  });
});

describe('terminal signals (CA-28)', () => {
  it('builds bell / OSC 9 / OSC 777 sequences per mode', () => {
    expect(signalSequence('off', 'turn-complete')).toBe('');
    expect(signalSequence('bell', 'turn-complete')).toBe('\x07');
    const osc = signalSequence('osc', 'approval-needed');
    expect(osc).toContain('\x1b]9;Approval needed\x07');
    expect(osc).toContain('\x1b]777;notify;KriyaDot;Approval needed\x07');
    expect(osc).not.toContain('\x07\x1b]9'); // no bell in osc-only mode
    expect(signalSequence('both', 'turn-complete').startsWith('\x07')).toBe(true);
  });

  it('emitTerminalSignal writes through the sink and reports length', () => {
    const written: string[] = [];
    const n = emitTerminalSignal((s) => written.push(s), 'bell', 'turn-complete');
    expect(n).toBe(1);
    expect(written).toEqual(['\x07']);
    expect(emitTerminalSignal((s) => written.push(s), 'off', 'turn-complete')).toBe(0);
    expect(written).toHaveLength(1);
  });

  it('resolveNotifyMode prefers explicit, then env, then bell', () => {
    expect(resolveNotifyMode('osc')).toBe('osc');
    expect(resolveNotifyMode('bogus' as never)).toBe(process.env.KRIYADOT_NOTIFY === 'osc' ? 'osc' : 'bell');
  });
});

describe('REPL /rewind and /diff (CA-4 / CA-30)', () => {
  function checkpointDeps(lines: string[]) {
    const fake = makeFakeApi({});
    const deps = makeDeps(fake);
    const restores: Array<{ id: string; mode: string }> = [];
    return {
      deps,
      restores,
      run: () =>
        runRepl(
          {
            api: fake.asApi(),
            botName: 'Helper',
            out: (s) => deps.stdout.write(s),
            err: (s) => deps.stderr.write(s),
            lines: makeFakeLines(lines),
            clearScreen: () => undefined,
            notifyMode: 'off' as const,
            listCheckpoints: async () => CPS,
            restoreCheckpoint: async (id, mode) => {
              restores.push({ id, mode });
              return { ok: true, restoredFiles: ['src/a.ts'], messagesRemoved: 2 };
            },
            restoreCheckpointSummarized: async () => ({ ok: true, summary: 'SUM', messagesRemoved: 2 }),
            sessionDiff: async () => ({
              files: [{ path: 'src/a.ts', status: 'modified', added: 3, removed: 1, touches: 2 }],
            }),
          },
          { botId: 'helper', sessionId: 's1' },
        ),
    };
  }

  it('/rewind lists checkpoints; /rewind 1 restores both by default', async () => {
    const { deps, restores, run } = checkpointDeps(['/rewind', '/rewind 1', '/quit']);
    await run();
    expect(deps.stderrText()).toContain('before patch'); // newest listed first? list is in given order
    expect(restores).toEqual([{ id: 'cp-1111', mode: 'both' }]);
    expect(deps.stderrText()).toContain('1 file(s), 2 message(s) removed');
  });

  it('/rewind 2 summarize goes through the summarized restore', async () => {
    const { deps, run } = checkpointDeps(['/rewind 2 summarize', '/quit']);
    await run();
    expect(deps.stderrText()).toContain('summarized 2 message(s)');
    expect(deps.stderrText()).toContain('SUM');
  });

  it('/diff prints the server aggregate', async () => {
    const { deps, run } = checkpointDeps(['/diff', '/quit']);
    await run();
    expect(deps.stderrText()).toContain('src/a.ts');
    expect(deps.stderrText()).toContain('+3 -1');
  });

  it('emits a bell on turn completion when notifyMode=bell', async () => {
    const fake = makeFakeApi({ chatScript: [{ type: 'token', content: 'hi' }, { type: 'done' }] });
    const deps = makeDeps(fake);
    const signals: string[] = [];
    await runRepl(
      {
        api: fake.asApi(),
        botName: 'Helper',
        out: (s) => deps.stdout.write(s),
        err: (s) => deps.stderr.write(s),
        lines: makeFakeLines(['hello', '/quit']),
        clearScreen: () => undefined,
        notifyMode: 'bell',
        signalWrite: (s) => signals.push(s),
      },
      { botId: 'helper' },
    );
    expect(signals).toEqual(['\x07']);
  });
});
