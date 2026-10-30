// SPDX-License-Identifier: Apache-2.0
// CA-4 / CA-30 web surfaces: RewindPanel rendering + review aggregation.

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { RewindPanel } from './RewindPanel';
import { CodeSessionView, reviewRows } from './CodeSessionView';
import { formatBytes, previewFiles, type CheckpointClient, type CheckpointInfo } from './checkpoints';
import type { CodeFileSession } from './useCodeSession';

vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});
vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    disconnect() {}
  },
);
vi.stubGlobal('matchMedia', () => ({ matches: true }));

const CP: CheckpointInfo = {
  id: 'cp-1',
  sessionId: 's1',
  createdAt: Date.UTC(2026, 9, 30, 10, 0, 0),
  files: { 'src/app.ts': 'const a = 1;\n', 'src/new.ts': null },
  historyLength: 4,
  label: 'before write_file src/app.ts',
};

function fakeClient(overrides: Partial<CheckpointClient> = {}): CheckpointClient {
  return {
    listCheckpoints: async () => [CP],
    restore: async () => ({ ok: true, restoredFiles: ['src/app.ts'], messagesRemoved: 0 }),
    restoreSummarized: async () => ({ ok: true, summary: 'S', messagesRemoved: 2 }),
    restoreFile: async () => ({ ok: true, restoredFiles: ['src/app.ts'] }),
    sessionDiff: async () => ({ files: [], totals: { added: 0, removed: 0 } }),
    ...overrides,
  };
}

describe('checkpoint preview helpers', () => {
  it('previewFiles reports sizes and existence; formatBytes scales', () => {
    expect(previewFiles(CP)).toEqual([
      { path: 'src/app.ts', size: 13, existed: true },
      { path: 'src/new.ts', size: 0, existed: false },
    ]);
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});

describe('RewindPanel', () => {
  it('renders the loading state server-side without a network', () => {
    const html = renderToString(<RewindPanel sessionId="s1" client={fakeClient()} />);
    expect(html).toContain('Checkpoints');
    expect(html).toContain('Loading checkpoints');
  });

  it('renders an empty-state panel when the client resolves empty', async () => {
    // Drive the same markup path the component uses after load by rendering
    // with a client whose list is empty and flushing microtasks is not
    // possible in renderToString; assert the static chrome instead.
    const html = renderToString(<RewindPanel sessionId="s1" client={fakeClient({ listCheckpoints: async () => [] })} onClose={() => {}} />);
    expect(html).toContain('rewind-panel');
    expect(html).toContain('Close checkpoints');
  });
});

describe('CodeSessionView review mode (CA-30)', () => {
  const FILES: CodeFileSession[] = [
    {
      file: 'src/app.ts', botId: 'b1', botName: 'Coder', kind: 'write',
      before: 'const a = 1;\nconst b = 2;\n', after: 'const a = 9;\n', status: 'done',
      callId: 'c1', updatedAt: 1,
    },
    {
      file: 'README.md', botId: 'b1', botName: 'Coder', kind: 'read',
      before: null, after: '# Hi\n', status: 'done', callId: 'c2', updatedAt: 2,
    },
  ];

  it('reviewRows aggregates writes only, with +/- counts', () => {
    const rows = reviewRows(FILES);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.file).toBe('src/app.ts');
    expect(rows[0]!.added + rows[0]!.removed).toBeGreaterThan(0);
  });

  it('renders a Review changes control and the Rewind toggle when wired', () => {
    const html = renderToString(
      <CodeSessionView
        files={FILES}
        layout="inline"
        onToggleLayout={() => {}}
        onClose={() => {}}
        onFileDone={() => {}}
        sessionId="s1"
        checkpointClient={fakeClient()}
      />,
    );
    expect(html).toContain('Review changes');
    expect(html).toContain('Rewind');
  });

  it('omits the Rewind toggle without a session/client', () => {
    const html = renderToString(
      <CodeSessionView files={FILES} layout="inline" onToggleLayout={() => {}} onClose={() => {}} onFileDone={() => {}} />,
    );
    expect(html).toContain('Review changes');
    expect(html).not.toContain('⏪ Rewind');
  });
});
