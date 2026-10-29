// SPDX-License-Identifier: Apache-2.0
// Goal status card for `/goal` runs started in a 1:1 chat (W8f).
// Polls the group-goals API (the same record the Teams → Goals panel
// shows) until the run reaches a terminal/paused status.

'use client';

import React, { useEffect, useState } from 'react';
import { fetchGroupGoal, type GroupGoalSummary } from '../../lib/api';

const TERMINAL = new Set(['completed', 'stopped', 'failed', 'needs-input', 'blocked', 'max-turns']);

export function GoalStatusCard({ goalId, title }: { goalId: string; title: string }) {
  const [goal, setGoal] = useState<GroupGoalSummary | null>(null);
  const [turns, setTurns] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetchGroupGoal(goalId);
        if (!alive) return;
        setGoal(res.goal);
        setTurns(res.turns.length);
        if (!TERMINAL.has(res.goal.status)) {
          timer = setTimeout(() => void poll(), 3000);
        }
      } catch {
        if (alive) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [goalId]);

  const status = goal?.status ?? 'running';
  return (
    <div className="goal-card" style={{ borderLeft: '3px solid var(--accent)', padding: '6px 10px', margin: '6px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span aria-hidden="true">🎯</span>
        <strong>{title}</strong>
        <span className={`chip ${status === 'completed' ? 'green' : status === 'failed' || status === 'blocked' ? 'red' : 'gray'}`}>{status}</span>
        {goal && (
          <span className="small muted">
            turn {turns}/{goal.maxTurns}
          </span>
        )}
      </div>
      {goal?.summary && <div className="small" style={{ marginTop: 4 }}>{goal.summary}</div>}
    </div>
  );
}
