// SPDX-License-Identifier: Apache-2.0
'use client';

import { useState } from 'react';
import { ApprovalsPanel } from '../../components/panels/approvals-panel';
import { AuditPanel } from '../../components/panels/audit-panel';
import { BriefingPanel } from '../../components/activity/briefing-panel';
import { SpacePanel } from '../../components/activity/space-panel';
import { OmniPanel } from '../../components/activity/omni-panel';
import { CostPanel } from '../../components/activity/cost-panel';
import { useUxMode } from '../../lib/ux-mode';

import { RulesPanel } from '../../components/activity/rules-panel';
import { HealthPanel } from '../../components/activity/health-panel';
import { RoutingPanel } from '../../components/activity/routing-panel';
import { RecoveryPanel } from '../../components/activity/recovery-panel';

const TABS = [
  { id: 'briefing', label: 'Briefing', pro: false },
  { id: 'approvals', label: 'Approvals', pro: false },
  { id: 'spaces', label: 'Spaces', pro: false },
  { id: 'summary', label: 'Summary', pro: false },
  { id: 'rules', label: 'Rules', pro: false },
  { id: 'routing', label: 'Routing', pro: false },
  { id: 'recovery', label: 'Recovery', pro: false },
  { id: 'health', label: 'Health', pro: false },
  { id: 'cost', label: 'Cost', pro: true },
  { id: 'audit', label: 'Audit log', pro: false },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function ActivityPage() {
  const [tab, setTab] = useState<TabId>('approvals');
  const [mode] = useUxMode();
  const visibleTabs = TABS.filter((t) => !t.pro || mode === 'pro');
  const activeTab: TabId = visibleTabs.some((t) => t.id === tab) ? tab : 'approvals';

  return (
    <div>
      <h1 className="page-title">Activity</h1>
      <p className="page-sub">
        Everything the platform does and asks of you — briefing, human approvals, spaces,
        summaries, processing rules, cost, and the audit trail.
      </p>
      <div className="tabs" role="tablist" aria-label="Activity sections">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={activeTab === t.id}
            className={`tab${activeTab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tab-panel page-enter" key={activeTab} role="tabpanel">
        {activeTab === "briefing" && <BriefingPanel />}
        {activeTab === "approvals" && <ApprovalsPanel hideHeader />}
        {activeTab === "spaces" && <SpacePanel />}
        {activeTab === "summary" && <OmniPanel />}
        {activeTab === "rules" && <RulesPanel />}
        {activeTab === "routing" && <RoutingPanel />}
        {activeTab === "recovery" && <RecoveryPanel />}
        {activeTab === "health" && <HealthPanel />}
        {activeTab === "cost" && <CostPanel />}
        {activeTab === "audit" && <AuditPanel hideHeader />}
      </div>
    </div>
  );
}
