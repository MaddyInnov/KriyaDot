// SPDX-License-Identifier: Apache-2.0
// Dialog for creating a group chat (multi-bot room): name + member picker.

'use client';

import { useState } from 'react';

export interface DialogBot {
  id: string;
  name: string;
  description?: string;
}

interface Props {
  bots: DialogBot[];
  onCreate: (name: string, memberBotIds: string[], description?: string) => Promise<void>;
  onClose: () => void;
}

export function GroupCreateDialog({ bots, onCreate, onClose }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Give the group a name.');
      return;
    }
    if (selected.size === 0) {
      setError('Pick at least one bot.');
      return;
    }
    setBusy(true);
    try {
      await onCreate(name.trim(), [...selected], description.trim() || undefined);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create group.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New group chat"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>New group chat</h2>
        <p className="small muted">
          Several bots in one room. Mention <code>@name</code> to pick who replies, or say
          nothing and everyone answers.
        </p>
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Dev team"
            maxLength={80}
            autoFocus
          />
        </label>
        <label className="field">
          <span>Description <span className="muted">(optional)</span></span>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this room for?"
            maxLength={200}
          />
        </label>
        <div className="field">
          <span>Members ({selected.size})</span>
          <div className="member-picker">
            {bots.map((b) => (
              <label key={b.id} className={`member-option${selected.has(b.id) ? ' selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={selected.has(b.id)}
                  onChange={() => toggle(b.id)}
                />
                <span className="member-name">{b.name}</span>
                {b.description && <span className="member-desc small muted">{b.description}</span>}
              </label>
            ))}
            {bots.length === 0 && <div className="small muted">No bots available.</div>}
          </div>
        </div>
        {error && (
          <div className="error small" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      </div>
    </div>
  );
}
