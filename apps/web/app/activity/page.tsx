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
import { useCollapsed } from '../../lib/use-collapsed';
import { CollapseChevron } from '../../components/collapse';

import { RulesPanel } from '../../components/activity/rules-panel';
import { WatchPanel } from '../../components/activity/watch-panel';
import { NotificationPanel } from '../../components/activity/notification-panel';
import { HealthPanel } from '../../components/activity/health-panel';
import { ServicesPanel } from '../../components/activity/services-panel';
import { RoutingPanel } from '../../components/activity/routing-panel';
import { RecoveryPanel } from '../../components/activity/recovery-panel';
import { RunsPanel } from '../../components/activity/runs-panel';
import { HumanAccountingPanel } from '../../components/activity/human-accounting-panel';
import { SessionAnalyzePanel } from '../../components/activity/session-analyze-panel';
import { UnifiedStatusPanel } from '../../components/activity/unified-status-panel';
import { WorkPanel } from '../../components/activity/work-panel';
import { PermissionsSummary } from '../../components/activity/permissions-summary';

const TABS = [
  { id: 'work', label: 'Work', pro: false },
  { id: 'briefing', label: 'Briefing', pro: false },
  { id: 'watch', label: 'Watch', pro: false },
  { id: 'notifications', label: 'Notifications', pro: false },
  { id: 'approvals', label: 'Approvals', pro: false },
  { id: 'runs', label: 'Runs', pro: false },
  { id: 'status', label: 'Status', pro: false },
  { id: 'analyze', label: 'Analyze', pro: false },
  { id: 'human', label: 'Human time', pro: false },
  { id: 'spaces', label: 'Spaces', pro: false },
  { id: 'summary', label: 'Summary', pro: false },
  { id: 'rules', label: 'Rules', pro: false },
  { id: 'routing', label: 'Routing', pro: false },
  { id: 'recovery', label: 'Recovery', pro: false },
  { id: 'health', label: 'Health', pro: false },
  { id: 'services', label: 'Services', pro: false },
  { id: 'cost', label: 'Cost', pro: true },
  { id: 'audit', label: 'Audit log', pro: false },
  { id: 'permissions', label: 'Permissions', pro: false },
] as const;

type TabId = (typeof TABS)[number]['id'];

// Declutter: the Pro tab bar's primary row — the five sections a user
// checks daily. Every other section lives one click away under the
// "More sections" disclosure (grouped in MORE_IDS order below).
const PRIMARY_IDS: TabId[] = ['work', 'approvals', 'runs', 'briefing', 'notifications'];
const MORE_IDS: TabId[] = [
  'status',
  'analyze',
  'human',
  'spaces',
  'summary',
  'rules',
  'routing',
  'recovery',
  'health',
  'services',
  'cost',
  'audit',
  'watch',
  'permissions',
];

// Simple mode's consumer row (ACT-2): the same underlying panels, framed
// as the four questions a non-technical user actually asks.
const CONSUMER_MODES = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'approvals', label: 'Approvals & safety' },
  { id: 'history', label: 'History' },
  { id: 'permissions', label: 'Permissions & identity' },
] as const;

type ConsumerMode = (typeof CONSUMER_MODES)[number]['id'];

export default function ActivityPage() {
  const [tab, setTab] = useState<TabId>('work');
  const [consumerMode, setConsumerMode] = useState<ConsumerMode>('tasks');
  // "More sections" disclosure — shared collapse pattern, persisted
  // (`kriyadot:collapse:activity-more`).
  const moreSection = useCollapsed('activity-more', true);
  const moreOpen = !moreSection.collapsed;
  const [mode] = useUxMode();
  const visibleTabs = TABS.filter((t) => !t.pro || mode === 'pro');
  const activeTab: TabId = visibleTabs.some((t) => t.id === tab) ? tab : 'work';
  const primaryTabs = visibleTabs.filter((t) => PRIMARY_IDS.includes(t.id));
  const moreTabs = visibleTabs.filter((t) => MORE_IDS.includes(t.id));
  // The More row stays visible while a More section is active, even if
  // the disclosure was never opened.
  const showMore = moreOpen || moreTabs.some((t) => t.id === activeTab);

  return (
    <div>
      <h1 className="page-title">Activity</h1>
      <p className="page-sub dc-compact-sub">
        Everything the platform does and asks of you — in one place.
      </p>

      {mode === 'simple' ? (
        <>
          <div className="tabs" role="tablist" aria-label="Activity modes">
            {CONSUMER_MODES.map((m) => (
              <button
                key={m.id}
                role="tab"
                aria-selected={consumerMode === m.id}
                className={`tab${consumerMode === m.id ? " active" : ""}`}
                onClick={() => setConsumerMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="tab-panel page-enter" key={consumerMode} role="tabpanel">
            {consumerMode === 'tasks' && <WorkPanel />}
            {consumerMode === 'approvals' && <ApprovalsPanel hideHeader />}
            {consumerMode === 'history' && <WorkPanel variant="history" />}
            {consumerMode === 'permissions' && <PermissionsSummary />}
          </div>
        </>
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label="Activity sections">
            {primaryTabs.map((t) => (
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
            <button
              type="button"
              className="tab dc-more-toggle"
              aria-expanded={showMore}
              aria-controls="activity-more-sections"
              onClick={moreSection.toggle}
            >
              More sections <CollapseChevron collapsed={!showMore} />
            </button>
          </div>
          {showMore && (
            <div
              className="tabs dc-more-tabs"
              role="tablist"
              aria-label="More activity sections"
              id="activity-more-sections"
            >
              {moreTabs.map((t) => (
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
          )}
          <div className="tab-panel page-enter" key={activeTab} role="tabpanel">
            {activeTab === "work" && <WorkPanel />}
            {activeTab === "briefing" && <BriefingPanel />}
            {activeTab === "watch" && <WatchPanel />}
            {activeTab === "notifications" && <NotificationPanel />}
            {activeTab === "approvals" && <ApprovalsPanel hideHeader />}
            {activeTab === "runs" && <RunsPanel />}
            {activeTab === "status" && <UnifiedStatusPanel />}
            {activeTab === "analyze" && <SessionAnalyzePanel />}
            {activeTab === "human" && <HumanAccountingPanel />}
            {activeTab === "spaces" && <SpacePanel />}
            {activeTab === "summary" && <OmniPanel />}
            {activeTab === "rules" && <RulesPanel />}
            {activeTab === "routing" && <RoutingPanel />}
            {activeTab === "recovery" && <RecoveryPanel />}
            {activeTab === "health" && <HealthPanel />}
            {activeTab === "services" && <ServicesPanel />}
            {activeTab === "cost" && <CostPanel />}
            {activeTab === "audit" && <AuditPanel hideHeader />}
            {activeTab === "permissions" && <PermissionsSummary />}
          </div>
        </>
      )}
    </div>
  );
}
