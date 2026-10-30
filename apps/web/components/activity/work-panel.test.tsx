// SPDX-License-Identifier: Apache-2.0
// WorkPanel consumer view: the header renders the live status sentence,
// day groups render with their label, and a running row is visually
// distinct (accent border + animated icon, no outcome text chip).
// Rendered via renderToStaticMarkup like Pet.test.tsx — no DOM needed.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  StatusIcon,
  WorkDayGroupView,
  WorkItemRow,
  WorkPanelHeader,
  type WorkItem,
} from './work-panel';
import { PermissionsSummaryView, type PermissionsSummaryData } from './permissions-summary';

function item(partial: Partial<WorkItem> & { runId: string }): WorkItem {
  return {
    source: 'observability',
    title: 'Research standing desks',
    outcome: 'Working on it right now.',
    status: 'running',
    timestamp: new Date(2026, 9, 30, 10, 30).getTime(),
    endedAt: null,
    botId: 'chief',
    botName: 'Chief',
    attempts: [],
    ...partial,
  };
}

describe('WorkPanelHeader', () => {
  it('renders the agent name, live status sentence, and an edit link', () => {
    const html = renderToStaticMarkup(
      <WorkPanelHeader
        petId="kriyadot"
        agentName="KriyaDot"
        sentence="Running 2 tasks — researching desks · writing notes"
        idle={false}
      />,
    );
    expect(html).toContain('KriyaDot');
    expect(html).toContain('Running 2 tasks — researching desks · writing notes');
    expect(html).toContain('href="/preferences"');
    expect(html).toContain('<svg');
  });

  it('renders the idle sentence when nothing is running', () => {
    const html = renderToStaticMarkup(
      <WorkPanelHeader petId="kriyadot" agentName="KriyaDot" sentence="Nothing running right now" idle />,
    );
    expect(html).toContain('Nothing running right now');
  });
});

describe('WorkDayGroupView', () => {
  it('renders the Today group with its items', () => {
    const html = renderToStaticMarkup(
      <WorkDayGroupView
        group={{
          date: '2026-10-30',
          label: 'Today',
          items: [item({ runId: 'r1' }), item({ runId: 'r2', status: 'completed', title: 'Plan my week', outcome: 'Finished — all done.' })],
        }}
      />,
    );
    expect(html).toContain('Today');
    expect(html).toContain('Research standing desks');
    expect(html).toContain('Plan my week');
  });
});

describe('WorkItemRow status treatment', () => {
  it('marks the running row as distinct with an animated icon and no text chip', () => {
    const html = renderToStaticMarkup(<WorkItemRow item={item({ runId: 'live1' })} />);
    expect(html).toContain('work-row-running');
    expect(html).toContain('data-status-icon="running"');
    expect(html).toContain('work-status-running');
    // Iconography replaces outcome chips in this view.
    expect(html).not.toContain('chip');
  });

  it('uses a check-circle icon for completed work', () => {
    const html = renderToStaticMarkup(
      <WorkItemRow item={item({ runId: 'done1', status: 'completed', outcome: 'Finished — all done.' })} />,
    );
    expect(html).toContain('data-status-icon="completed"');
    expect(html).not.toContain('work-row-running');
  });

  it('uses a document icon while writing and a failure mark when failed', () => {
    const writing = renderToStaticMarkup(<StatusIcon status="writing" />);
    expect(writing).toContain('data-status-icon="writing"');
    const failed = renderToStaticMarkup(<StatusIcon status="failed" />);
    expect(failed).toContain('data-status-icon="failed"');
  });
});

describe('PermissionsSummaryView', () => {
  const data: PermissionsSummaryData = {
    principal: { kind: 'owner', userId: 'default-user', assertedProfile: false },
    bots: [
      {
        botId: 'chief',
        botName: 'Chief',
        approvalMode: 'auto',
        policyRuleCount: 2,
        allowCount: 1,
        denyCount: 0,
        requireApprovalCount: 1,
        lastingAllowCount: 1,
        toolCount: 5,
      },
    ],
    vault: { secrets: 2, logins: 1, walletMethods: 1, accountsConnected: 1, accountsTotal: 2 },
    lastingAllowTotal: 1,
    pendingApprovals: 0,
  };

  it('renders principal, per-bot modes, and vault counts', () => {
    const html = renderToStaticMarkup(<PermissionsSummaryView data={data} />);
    expect(html).toContain('default-user');
    expect(html).toContain('Chief');
    expect(html).toContain('Acts on routine things, asks before anything risky');
    expect(html).toContain('1 saved login');
    expect(html).toContain('always allow');
  });
});
