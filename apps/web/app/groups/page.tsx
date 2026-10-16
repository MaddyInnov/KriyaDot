// SPDX-License-Identifier: Apache-2.0
// Group chats (multi-bot rooms): list, create, and chat.
// Each group is a roster row holding several bots; the user sends a message
// and @-mentioned members (or all) reply in turn, up to 3 rounds / 10 replies.
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getBots, type BotConfig } from '../../lib/api';
import {
  createGroup,
  deleteGroup,
  listGroups,
  type GroupChat,
} from '../../lib/group-chats';
import { GroupChatView } from '../../components/chat/group-chat-view';
import { GroupCreateDialog } from '../../components/chat/group-create-dialog';

export default function GroupsPage() {
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [groups, setGroups] = useState<GroupChat[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const botNames = useMemo(() => new Map(bots.map((b) => [b.id, b.name])), [bots]);
  const selected = groups.find((g) => g.id === selectedId) ?? null;

  const refresh = useCallback(async () => {
    try {
      const [b, g] = await Promise.all([getBots(), listGroups()]);
      setBots(b);
      setGroups(g);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async (name: string, memberBotIds: string[], description?: string) => {
    const { group } = await createGroup(name, memberBotIds, description);
    await refresh();
    setSelectedId(group.id);
  };

  const handleDelete = async (g: GroupChat) => {
    if (!confirm(`Delete group "${g.name}"? Its transcript will be lost.`)) return;
    try {
      await deleteGroup(g.id);
      if (selectedId === g.id) setSelectedId(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete.');
    }
  };

  return (
    <div className="page groups-page">
      <div className="page-head">
        <h1>👥 Group chats</h1>
        <p className="muted">
          Several bots in one room. Mention <code>@name</code> to pick who replies — or say
          nothing and everyone answers, up to 3 rounds.
        </p>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          ＋ New group chat
        </button>
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <div className="groups-layout">
        <aside className="groups-list" aria-label="Group chats">
          {groups.map((g) => (
            <div key={g.id} className={`convo-item${g.id === selectedId ? ' active' : ''}`}>
              <button className="convo-title" onClick={() => setSelectedId(g.id)}>
                <div className="group-row-name">{g.name}</div>
                <div className="small muted">
                  {g.memberBotIds.map((id) => botNames.get(id) ?? id).join(', ')}
                </div>
              </button>
              <span className="convo-actions">
                <button
                  className="icon-btn xs"
                  title={`Delete ${g.name}`}
                  aria-label={`Delete group ${g.name}`}
                  onClick={() => handleDelete(g)}
                >
                  🗑
                </button>
              </span>
            </div>
          ))}
          {groups.length === 0 && (
            <div className="small muted">
              No groups yet. Create one to get several bots answering together.
            </div>
          )}
        </aside>

        <main className="groups-main">
          {selected ? (
            <GroupChatView
              group={selected}
              botNames={botNames}
              onDeleted={() => {
                setSelectedId(null);
                refresh();
              }}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-icon">👥</div>
              <p className="muted">Pick a group on the left, or create a new one.</p>
            </div>
          )}
        </main>
      </div>

      {showCreate && (
        <GroupCreateDialog
          bots={bots.map((b) => ({ id: b.id, name: b.name, description: b.description }))}
          onCreate={handleCreate}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}
