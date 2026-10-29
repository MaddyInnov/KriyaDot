// SPDX-License-Identifier: Apache-2.0
// W14c briefing Signals: GitHub source over a mock Composio executor
// (PRs awaiting review, failing CI, mentions normalized into brief
// items), graceful degradation (not connected / executor error → brief
// still generates), and the W14b notification digest joining the brief.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { RunHealthStore } from '@mvp/run-health';
import { generateBriefing } from '../src/briefing.js';
import {
  createGithubSignalsSource,
  normalizeGithubSignals,
  resolveGithubSignalsSource,
} from '../src/briefing-signals.js';
import type { ComposioEventExecutor } from '../src/routine-events.js';
import { NotificationStore } from '../src/notification-triage.js';

const PRS = [
  {
    number: 12,
    title: 'Fix the flaky test',
    state: 'open',
    updated_at: '2026-10-29T10:00:00Z',
    requested_reviewers: [{ login: 'ashutosh' }],
  },
  {
    number: 13,
    title: 'Bump dependencies',
    state: 'open',
    updated_at: '2026-10-29T09:00:00Z',
    ci_status: 'failure',
  },
  {
    number: 14,
    title: 'Old closed PR',
    state: 'closed',
    updated_at: '2026-10-28T09:00:00Z',
    requested_reviewers: [{ login: 'ashutosh' }],
  },
  {
    number: 15,
    title: 'Unrelated open PR',
    state: 'open',
    updated_at: '2026-10-29T08:00:00Z',
    requested_reviewers: [{ login: 'someone-else' }],
  },
];

const ISSUES = [
  { number: 7, title: 'Question about the roadmap', body: 'cc @ashutosh — thoughts?', updated_at: '2026-10-29T07:00:00Z' },
  { number: 8, title: 'Bug: crash on start', body: 'stack trace attached', updated_at: '2026-10-29T06:00:00Z' },
  // Interleaved PR in the issues list must be ignored.
  { number: 12, title: 'Fix the flaky test', pull_request: { url: 'x' }, body: '@ashutosh' },
];

describe('normalizeGithubSignals', () => {
  it('normalizes review requests, failing CI and mentions; skips closed/unrelated', () => {
    const items = normalizeGithubSignals({
      repo: 'acme/widgets',
      pullRequests: PRS,
      issues: ISSUES,
      username: 'ashutosh',
    });
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain('signal-review');
    expect(kinds).toContain('signal-ci');
    expect(kinds).toContain('signal-mention');
    expect(items).toHaveLength(3);
    expect(items.find((i) => i.kind === 'signal-review')!.title).toContain('PR #12');
    expect(items.find((i) => i.kind === 'signal-ci')!.title).toContain('PR #13');
    expect(items.find((i) => i.kind === 'signal-mention')!.title).toContain('issue #7');
  });

  it('without a username only failing CI surfaces (no guessing at review/mentions)', () => {
    const items = normalizeGithubSignals({ repo: 'acme/widgets', pullRequests: PRS, issues: ISSUES });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('signal-ci');
  });
});

describe('createGithubSignalsSource with a mock executor', () => {
  const executor: ComposioEventExecutor = {
    executeTool: async ({ toolSlug }) => {
      if (toolSlug === 'GITHUB_LIST_PULL_REQUESTS') return PRS;
      if (toolSlug === 'GITHUB_LIST_ISSUES') return ISSUES;
      throw new Error(`unexpected slug ${toolSlug}`);
    },
  };

  it('collects signals through the executor path', async () => {
    const source = createGithubSignalsSource({
      executor,
      userId: 'default-user',
      botId: 'chief',
      accountId: 'ca_github',
      repos: ['acme/widgets'],
      username: 'ashutosh',
    });
    const items = await source.collect();
    expect(items).toHaveLength(3);
  });

  it('executor error → empty (never throws)', async () => {
    const failing: ComposioEventExecutor = {
      executeTool: async () => {
        throw new Error('Composio is not connected');
      },
    };
    const source = createGithubSignalsSource({
      executor: failing,
      userId: 'default-user',
      botId: 'chief',
      accountId: 'ca_github',
      repos: ['acme/widgets'],
    });
    await expect(source.collect()).resolves.toEqual([]);
  });

  it('no account / no repos → empty', async () => {
    const source = createGithubSignalsSource({
      executor,
      userId: 'default-user',
      botId: 'chief',
      accountId: '',
      repos: [],
    });
    await expect(source.collect()).resolves.toEqual([]);
  });

  it('resolveGithubSignalsSource is null without repos configured or a GitHub account', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w14-signals-'));
    try {
      expect(resolveGithubSignalsSource({ dataDir: dir, executor, env: {} })).toBeNull();
      expect(
        resolveGithubSignalsSource({
          dataDir: dir,
          executor,
          env: { KRIYADOT_BRIEFING_GITHUB_REPOS: 'acme/widgets' },
        }),
      ).toBeNull(); // repos set, but no GitHub account in the cache
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('briefing integration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'w14-brief-'));
    process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
  });
  afterEach(() => {
    delete process.env.OLLAMA_HOST;
    rmSync(dir, { recursive: true, force: true });
  });

  function baseDeps() {
    return {
      governance: new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY }),
      runHealth: new RunHealthStore(join(dir, 'run-health.db')),
      dataDir: dir,
    };
  }

  it('signals + notification digest join the brief; summary mentions them', async () => {
    const notifStore = new NotificationStore(dir);
    const now = Date.now();
    notifStore.record(
      { deviceId: 'phone_1', appPackage: 'com.example.chat', title: 'Batched hello', ts: now },
      'batched',
      'default',
    );
    const briefing = await generateBriefing({
      ...baseDeps(),
      signalsSource: {
        collect: async () => [
          { id: 's1', title: 'PR #12 awaiting your review (acme/widgets)', kind: 'signal-review', ts: now },
        ],
      },
      notificationDigest: (since, n) => notifStore.digestItems(since, n),
    });
    expect(briefing.signals).toHaveLength(1);
    expect(briefing.signals![0]!.kind).toBe('signal-review');
    expect(briefing.notifications).toHaveLength(1);
    expect(briefing.summary).toContain('signal');
    expect(briefing.summary).toContain('notification');
  });

  it('a throwing signals source still yields a complete brief with an empty Signals section', async () => {
    const briefing = await generateBriefing({
      ...baseDeps(),
      signalsSource: {
        collect: async () => {
          throw new Error('executor exploded');
        },
      },
    });
    expect(briefing.signals).toEqual([]);
    expect(briefing.generatedAt).toBeGreaterThan(0);
    expect(briefing.summary).toBeTruthy();
  });

  it('with no sources wired the brief shape stays back-compatible', async () => {
    const briefing = await generateBriefing(baseDeps());
    expect(briefing.signals).toEqual([]);
    expect(briefing.notifications).toEqual([]);
  });
});
