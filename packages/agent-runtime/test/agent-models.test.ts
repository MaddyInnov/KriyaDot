// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock child_process before importing the module under test.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  discoverAgentModels,
  clearModelCache,
} from '../src/providers/agent-models.js';

const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearModelCache();
});

describe('discoverAgentModels', () => {
  it('returns [] for unknown agent ids without throwing', () => {
    expect(discoverAgentModels('no-such-agent')).toEqual([]);
  });

  it('returns [] when no binary is installed without throwing', () => {
    mockExec.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(discoverAgentModels('codex')).toEqual([]);
  });

  it('parses codex debug models output', () => {
    mockExec.mockImplementation((bin: string, args: string[]) => {
      if (bin === 'which' || bin === 'where') return '/usr/bin/codex';
      if (bin === 'codex') return 'gpt-5\n o3-mini \n some noise line\n';
      throw new Error('unexpected');
    });
    const models = discoverAgentModels('codex');
    expect(models.map((m) => m.id)).toContain('gpt-5');
    expect(models.map((m) => m.id)).toContain('o3-mini');
  });

  it('annotates reasoning-capable models', () => {
    mockExec.mockImplementation((bin: string) => {
      if (bin === 'which' || bin === 'where') return '/usr/bin/codex';
      if (bin === 'codex') return 'o3-mini\ngpt-4o-mini\n';
      throw new Error('unexpected');
    });
    const models = discoverAgentModels('codex');
    const o3 = models.find((m) => m.id === 'o3-mini');
    expect(o3?.supportsReasoningEffort).toBe(true);
  });

  it('caches results (second call does not re-probe)', () => {
    mockExec.mockImplementation((bin: string) => {
      if (bin === 'which' || bin === 'where') return '/usr/bin/codex';
      if (bin === 'codex') return 'gpt-5\n';
      throw new Error('unexpected');
    });
    discoverAgentModels('codex');
    const callsAfterFirst = mockExec.mock.calls.length;
    discoverAgentModels('codex');
    expect(mockExec.mock.calls.length).toBe(callsAfterFirst);
  });

  it('never throws when the probe binary crashes', () => {
    mockExec.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => discoverAgentModels('opencode')).not.toThrow();
    expect(discoverAgentModels('opencode')).toEqual([]);
  });
});
