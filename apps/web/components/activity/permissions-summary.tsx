// SPDX-License-Identifier: Apache-2.0
'use client';

// ACT-9: Permissions & identity — one plain-language pane answering
// "what can my agent do, and as whom?" Data comes from
// GET /api/work-panel/permissions (counts only; secret values are never
// part of the payload). Enforcement stays in governance / bot policies —
// this pane is read-only.

import React, { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api';

export interface BotPermissionSummary {
  botId: string;
  botName: string;
  approvalMode: string;
  policyRuleCount: number;
  allowCount: number;
  denyCount: number;
  requireApprovalCount: number;
  lastingAllowCount: number;
  toolCount: number;
}

export interface PermissionsSummaryData {
  principal: { kind: string; userId: string; assertedProfile: boolean; orgId?: string };
  bots: BotPermissionSummary[];
  vault: {
    secrets: number;
    logins: number;
    walletMethods: number;
    accountsConnected: number;
    accountsTotal: number;
  };
  lastingAllowTotal: number;
  pendingApprovals: number | null;
}

const MODE_LABEL: Record<string, string> = {
  plan: 'Asks with a plan first',
  auto: 'Acts on routine things, asks before anything risky',
  bypass: 'Acts without asking (bypass)',
};

export function modeLabel(mode: string): string {
  return MODE_LABEL[mode] ?? mode;
}

/** Presentational view (server-renderable; unit-tested without fetching). */
export function PermissionsSummaryView({ data }: { data: PermissionsSummaryData }) {
  return (
    <div data-testid="permissions-summary">
      <div className="card">
        <strong>Acting as you</strong>
        <p className="small" style={{ margin: '6px 0 0' }}>
          Signed in as <span className="mono">{data.principal.userId}</span>
          {data.principal.orgId ? (
            <>
              {' '}in workspace <span className="mono">{data.principal.orgId}</span>
            </>
          ) : null}
          . Your agent only acts under this verified identity — it cannot
          borrow someone else&apos;s.
        </p>
        {data.pendingApprovals !== null && (
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            {data.pendingApprovals === 0
              ? 'Nothing is waiting for your approval right now.'
              : `${data.pendingApprovals} thing${data.pendingApprovals === 1 ? '' : 's'} waiting for your approval.`}
          </p>
        )}
      </div>

      <div className="card">
        <strong>What your helpers may do</strong>
        {data.bots.length === 0 && <p className="small muted">No helpers yet.</p>}
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
          {data.bots.map((bot) => (
            <li key={bot.botId} style={{ padding: '6px 0', borderBottom: '1px solid var(--border, rgba(127,127,127,0.2))' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong className="small">{bot.botName}</strong>
                <span className="small muted">{modeLabel(bot.approvalMode)}</span>
              </div>
              <div className="small muted">
                {bot.toolCount} tools · {bot.policyRuleCount} safety rules
                {bot.lastingAllowCount > 0
                  ? ` · you said "always allow" ${bot.lastingAllowCount} time${bot.lastingAllowCount === 1 ? '' : 's'}`
                  : ''}
              </div>
            </li>
          ))}
        </ul>
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          {data.lastingAllowTotal === 0
            ? 'You have not given any lasting "always allow" permissions.'
            : `${data.lastingAllowTotal} lasting "always allow" permission${data.lastingAllowTotal === 1 ? '' : 's'} in total — you can take any of them back from the helper's settings.`}
        </p>
      </div>

      <div className="card">
        <strong>Saved logins &amp; wallet</strong>
        <p className="small" style={{ margin: '6px 0 0' }}>
          {data.vault.logins} saved login{data.vault.logins === 1 ? '' : 's'} ·{' '}
          {data.vault.secrets} saved secret{data.vault.secrets === 1 ? '' : 's'} ·{' '}
          {data.vault.walletMethods} payment card{data.vault.walletMethods === 1 ? '' : 's'} on file ·{' '}
          {data.vault.accountsConnected} of {data.vault.accountsTotal} accounts connected.
        </p>
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          Passwords and card numbers stay locked in the vault — your agent can
          use a saved login to sign in for you, but it can never see or share
          the password itself.
        </p>
      </div>
    </div>
  );
}

export function PermissionsSummary() {
  const [data, setData] = useState<PermissionsSummaryData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authedFetch('/api/work-panel/permissions');
      if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
      const body = (await res.json()) as { summary: PermissionsSummaryData };
      setData(body.summary);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <p className="muted">Loading permissions…</p>;
  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">No permission information yet.</p>;
  return (
    <div>
      {error && <div className="error">{error}</div>}
      <PermissionsSummaryView data={data} />
    </div>
  );
}
