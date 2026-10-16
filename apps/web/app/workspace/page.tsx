// SPDX-License-Identifier: Apache-2.0
'use client';

import { useState } from 'react';
import { NotesPanel } from '../../components/panels/notes-panel';
import { TasksPanel } from '../../components/panels/tasks-panel';
import { FilesPanel } from '../../components/panels/files-panel';
import PhonePanel from '../../components/panels/phone-panel';
import DevicesPanel from '../../components/panels/devices-panel';
import BackupPanel from '../../components/panels/backup-panel';

const TABS = [
  { id: 'notes', label: 'Notes' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'files', label: 'Files' },
  { id: 'phone', label: 'Phone', title: 'Control your phone' },
  { id: 'devices', label: 'Devices', title: 'Control KriyaDot from your phone' },
  { id: 'backup', label: 'Backup', title: 'Back up and restore your workspace' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function WorkspacePage() {
  const [tab, setTab] = useState<TabId>('notes');
  return (
    <div>
      <h1 className="page-title">Workspace</h1>
      <p className="page-sub">Notes, tasks, files — control your phone from here, or control KriyaDot from your phone — in one personal working surface.</p>
      <div className="tabs" role="tablist" aria-label="Workspace sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
            title={'title' in t ? t.title : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tab-panel page-enter" key={tab} role="tabpanel">
        {tab === 'notes' ? (
          <NotesPanel hideHeader />
        ) : tab === 'tasks' ? (
          <TasksPanel hideHeader />
        ) : tab === 'phone' ? (
          <PhonePanel />
        ) : tab === 'devices' ? (
          <DevicesPanel />
        ) : tab === 'backup' ? (
          <BackupPanel />
        ) : (
          <FilesPanel />
        )}
      </div>
    </div>
  );
}
