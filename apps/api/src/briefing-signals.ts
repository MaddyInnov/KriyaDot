// SPDX-License-Identifier: Apache-2.0
// Briefing "Signals" source (W14c): connected-app signals for the Chief's
// daily brief — today: GitHub via the existing Composio connection.
//
// Signals collected per configured repo (through the exact W2/W5 executor
// path — createComposioEventExecutor: vault key → account resolution →
// per-bot enable gate → executeTool; no parallel client, no credentials
// in this module):
//   - PRs awaiting the user's review (the user is a requested reviewer)
//   - Failing CI on open PRs (when the provider payload carries a check /
//     status field that says so — absent fields are NOT guessed at)
//   - Mentions of the user in issue/PR titles or bodies
//
// Graceful degradation is the contract: GitHub not connected, no repos
// configured, or any executor error → an empty list, and the brief still
// generates without a Signals section.
//
// Figma: NOT implemented. The Composio toolkit catalog in this codebase
// is dynamic (fetched from the Composio backend via listApps at runtime);
// no Figma toolkit, tool slug, or connected-account shape exists anywhere
// in the repo to build or test against, so a Figma source cannot be
// verified here. It is skipped deliberately rather than faked — see the
// W14 report. The source-module shape below is the one a Figma source
// would follow once its toolkit is verifiable.

import { readAccountCache } from './composio-accounts.js';
import type { ComposioEventExecutor } from './routine-events.js';
import type { BriefingItem } from './briefing.js';

export interface BriefingSignalSource {
  /** Normalized brief items; [] when unavailable. Must never throw. */
  collect(): Promise<BriefingItem[]>;
}

export interface GithubSignalsDeps {
  executor: ComposioEventExecutor;
  /** KriyaDot user that owns the Composio connection. */
  userId: string;
  /** Bot the executor's per-bot enable gate checks (the Chief). */
  botId: string;
  /** Connected GitHub account id (Composio nanoid). */
  accountId: string;
  /** Repos to scan, "owner/repo". Empty → no signals. */
  repos: string[];
  /** GitHub username of the user (review requests + mentions). Optional. */
  username?: string;
  /** Cap on items per repo scan. */
  limit?: number;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function collectItems(data: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.map(rec).filter((r) => Object.keys(r).length > 0);
  const d = rec(data);
  for (const k of keys) {
    if (Array.isArray(d[k])) return (d[k] as unknown[]).map(rec);
  }
  for (const v of Object.values(d)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = rec(v);
      for (const k of keys) {
        if (Array.isArray(inner[k])) return (inner[k] as unknown[]).map(rec);
      }
    }
  }
  return [];
}

function parseTs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.floor(v * 1000) : Math.floor(v);
  if (typeof v === 'string') {
    const d = Date.parse(v);
    if (Number.isFinite(d)) return d;
  }
  return 0;
}

/** Usernames requested to review a PR, from the varied payload shapes. */
function requestedReviewers(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['requested_reviewers', 'requestedReviewers', 'review_requests']) {
    const v = raw[key];
    if (Array.isArray(v)) {
      for (const entry of v) {
        if (typeof entry === 'string') out.push(entry);
        else {
          const login = str(rec(entry).login ?? rec(entry).username);
          if (login) out.push(login);
        }
      }
    }
  }
  return out;
}

/** CI verdict from a PR payload, only when a field actually reports one. */
function ciStatus(raw: Record<string, unknown>): 'failure' | 'success' | 'pending' | null {
  const candidates = [
    str(raw.ci_status),
    str(raw.ciStatus),
    str(raw.checks_status),
    str(raw.status),
    str(rec(raw.statusCheckRollup).state),
    str(rec(raw.checks).conclusion),
  ]
    .map((s) => s.toLowerCase())
    .filter(Boolean);
  for (const c of candidates) {
    if (c.includes('fail') || c === 'error' || c.includes('timed_out')) return 'failure';
    if (c.includes('success') || c === 'passed') return 'success';
    if (c.includes('pending') || c.includes('in_progress') || c.includes('queued')) return 'pending';
  }
  return null;
}

function mentionsUser(raw: Record<string, unknown>, username: string): boolean {
  const needle = `@${username.toLowerCase()}`;
  const hay = `${str(raw.title)} ${str(raw.body)}`.toLowerCase();
  return hay.includes(needle);
}

/**
 * Normalize GitHub list payloads (PRs + issues) into Signals brief items.
 * Pure — unit-tested directly. `username` gates review-request and
 * mention items; failing-CI items surface regardless of username.
 */
export function normalizeGithubSignals(input: {
  repo: string;
  pullRequests: unknown;
  issues: unknown;
  username?: string;
  limit?: number;
}): BriefingItem[] {
  const limit = input.limit ?? 10;
  const out: BriefingItem[] = [];
  const username = input.username?.trim().toLowerCase();
  const prs = collectItems(input.pullRequests, ['items', 'results', 'pull_requests']);
  for (const raw of prs) {
    const n = str(raw.number ?? raw.id);
    if (!n) continue;
    const title = str(raw.title);
    const ts = parseTs(raw.updated_at ?? raw.created_at);
    const state = str(raw.state).toLowerCase();
    if (state && state !== 'open') continue;
    if (ciStatus(raw) === 'failure') {
      out.push({
        id: `signal-github-${input.repo}-pr-${n}-ci`,
        title: `CI failing on PR #${n} (${input.repo})`,
        detail: title || undefined,
        ts,
        kind: 'signal-ci',
      });
      continue;
    }
    if (username && requestedReviewers(raw).some((r) => r.toLowerCase() === username)) {
      out.push({
        id: `signal-github-${input.repo}-pr-${n}-review`,
        title: `PR #${n} awaiting your review (${input.repo})`,
        detail: title || undefined,
        ts,
        kind: 'signal-review',
      });
      continue;
    }
    if (username && mentionsUser(raw, username)) {
      out.push({
        id: `signal-github-${input.repo}-pr-${n}-mention`,
        title: `You were mentioned on PR #${n} (${input.repo})`,
        detail: title || undefined,
        ts,
        kind: 'signal-mention',
      });
    }
  }
  const issues = collectItems(input.issues, ['items', 'results', 'issues']);
  for (const raw of issues) {
    if (raw.pull_request) continue; // the issues list interleaves PRs
    const n = str(raw.number ?? raw.id);
    if (!n || !username) continue;
    if (mentionsUser(raw, username)) {
      out.push({
        id: `signal-github-${input.repo}-issue-${n}-mention`,
        title: `You were mentioned on issue #${n} (${input.repo})`,
        detail: str(raw.title) || undefined,
        ts: parseTs(raw.updated_at ?? raw.created_at),
        kind: 'signal-mention',
      });
    }
  }
  return out.slice(0, limit);
}

/** GitHub Signals source over the shared Composio executor path. */
export function createGithubSignalsSource(deps: GithubSignalsDeps): BriefingSignalSource {
  return {
    async collect(): Promise<BriefingItem[]> {
      if (!deps.accountId || deps.repos.length === 0) return [];
      const out: BriefingItem[] = [];
      for (const repo of deps.repos.slice(0, 5)) {
        const [owner, name] = repo.split('/');
        if (!owner || !name) continue;
        try {
          const prData = await deps.executor.executeTool({
            userId: deps.userId,
            botId: deps.botId,
            accountId: deps.accountId,
            toolSlug: 'GITHUB_LIST_PULL_REQUESTS',
            args: { owner, repo: name, state: 'open', sort: 'updated', direction: 'desc', per_page: 25 },
          });
          const issueData = await deps.executor.executeTool({
            userId: deps.userId,
            botId: deps.botId,
            accountId: deps.accountId,
            toolSlug: 'GITHUB_LIST_ISSUES',
            args: { owner, repo: name, state: 'open', sort: 'updated', direction: 'desc', per_page: 25 },
          });
          out.push(
            ...normalizeGithubSignals({
              repo,
              pullRequests: prData,
              issues: issueData,
              username: deps.username,
              limit: deps.limit,
            }),
          );
        } catch {
          // One repo (or the whole connection) failing must not break the
          // brief — signals are best-effort by contract.
          continue;
        }
      }
      return out.slice(0, deps.limit ?? 10);
    },
  };
}

/**
 * Resolve the production GitHub source from local state: the first ACTIVE
 * GitHub account in the Composio account cache + the configured repo list
 * (env KRIYADOT_BRIEFING_GITHUB_REPOS="owner/repo,..." and username env
 * KRIYADOT_GITHUB_USERNAME). Returns null when GitHub is not connected or
 * no repos are configured — the brief then simply has no Signals section.
 */
export function resolveGithubSignalsSource(deps: {
  dataDir: string;
  executor: ComposioEventExecutor;
  userId?: string;
  botId?: string;
  env?: NodeJS.ProcessEnv;
}): BriefingSignalSource | null {
  const env = deps.env ?? process.env;
  const userId = deps.userId ?? 'default-user';
  const repos = (env.KRIYADOT_BRIEFING_GITHUB_REPOS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[^/\s]+\/[^/\s]+$/.test(s));
  if (repos.length === 0) return null;
  const cache = readAccountCache(deps.dataDir, userId);
  const github = Object.entries(cache).find(
    ([, r]) => r.toolkitSlug === 'github' && r.status === 'ACTIVE',
  );
  if (!github) return null;
  return createGithubSignalsSource({
    executor: deps.executor,
    userId,
    botId: deps.botId ?? 'chief',
    accountId: github[0],
    repos,
    username: env.KRIYADOT_GITHUB_USERNAME || undefined,
  });
}
