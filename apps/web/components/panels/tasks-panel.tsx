// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { authedFetch } from '../../lib/api';

interface Task {
  id: string;
  title: string;
  notes?: string;
  dueAt: string | null;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

const api = (path: string, init?: RequestInit): Promise<unknown> =>
  authedFetch(path, init).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json() as Promise<unknown>;
  });

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Local datetime-local value → ISO string. */
function toISO(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

type TaskFilter = 'open' | 'done' | 'all';

export function TasksPanel({ hideHeader = false }: { hideHeader?: boolean }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [filter, setFilter] = useState<TaskFilter>('open');
  const [error, setError] = useState('');
  // Task form
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [taskNotes, setTaskNotes] = useState('');
  // Event form
  const [evTitle, setEvTitle] = useState('');
  const [evStart, setEvStart] = useState('');
  const [evEnd, setEvEnd] = useState('');
  const [evNotes, setEvNotes] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [t, e] = await Promise.all([api('/api/tasks'), api('/api/events')]);
      setTasks(t as Task[]);
      setEvents(e as CalendarEvent[]);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleTasks = useMemo(
    () => tasks.filter((t) => (filter === 'all' ? true : filter === 'done' ? t.done : !t.done)),
    [tasks, filter],
  );

  const openCount = tasks.filter((t) => !t.done).length;

  const addTask = async () => {
    if (!taskTitle.trim()) {
      setError('A task title is required.');
      return;
    }
    try {
      const created = (await api('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: taskTitle.trim(),
          dueAt: toISO(taskDue),
          notes: taskNotes.trim() || undefined,
        }),
      })) as Task;
      setTasks((ts) => [...ts, created]);
      setTaskTitle('');
      setTaskDue('');
      setTaskNotes('');
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleTask = async (t: Task) => {
    try {
      const updated = (await api(`/api/tasks/${encodeURIComponent(t.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done: !t.done }),
      })) as Task;
      setTasks((ts) => ts.map((x) => (x.id === t.id ? updated : x)));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteTask = async (t: Task) => {
    try {
      await api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      setTasks((ts) => ts.filter((x) => x.id !== t.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addEvent = async () => {
    if (!evTitle.trim() || !evStart || !evEnd) {
      setError('Event needs a title, start, and end.');
      return;
    }
    try {
      const created = (await api('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: evTitle.trim(),
          startsAt: toISO(evStart),
          endsAt: toISO(evEnd),
          notes: evNotes.trim() || undefined,
        }),
      })) as CalendarEvent;
      setEvents((es) => [...es, created].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
      setEvTitle('');
      setEvStart('');
      setEvEnd('');
      setEvNotes('');
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteEvent = async (e: CalendarEvent) => {
    try {
      await api(`/api/events/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
      setEvents((es) => es.filter((x) => x.id !== e.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      {!hideHeader && (
        <>
          <h1 className="page-title">Tasks & Calendar</h1>
          <p className="page-sub">
            Your personal to-do list and calendar events. Scheduled workflows can also create tasks here.
          </p>
        </>
      )}
      {error && <div className="error-box">{error}</div>}

      <div className="grid-2">
        <div className="card">
          <div className="row-between">
            <strong>
              Tasks{openCount > 0 && <span className="chip blue"> {openCount} open</span>}
            </strong>
            <div>
              {(['open', 'done', 'all'] as TaskFilter[]).map((f) => (
                <button key={f} className={`btn btn-sm${filter === f ? ' btn-primary' : ''}`} onClick={() => setFilter(f)}>
                  {f[0].toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="task-title">
              New task
            </label>
            <input
              id="task-title"
              className="input"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="Task title"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addTask();
              }}
            />
          </div>
          <div className="row-between">
            <div className="field" style={{ flex: 1, marginRight: 8 }}>
              <label className="label" htmlFor="task-due">
                Due (optional)
              </label>
              <input
                id="task-due"
                type="datetime-local"
                className="input"
                value={taskDue}
                onChange={(e) => setTaskDue(e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="label" htmlFor="task-notes">
                Notes (optional)
              </label>
              <input
                id="task-notes"
                className="input"
                value={taskNotes}
                onChange={(e) => setTaskNotes(e.target.value)}
                placeholder="Details…"
              />
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => void addTask()}>
            Add task
          </button>

          <div className="mt">
            {visibleTasks.length === 0 ? (
              <p className="small muted">
                {filter === 'done' ? 'Nothing completed yet.' : 'No open tasks. Enjoy the calm.'}
              </p>
            ) : (
              visibleTasks.map((t) => (
                <div key={t.id} className="row-between" style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={t.done} onChange={() => void toggleTask(t)} aria-label={`Mark "${t.title}" ${t.done ? 'open' : 'done'}`} />
                    <div>
                      <span style={{ textDecoration: t.done ? 'line-through' : 'none' }}>{t.title}</span>
                      <div className="small muted">
                        {t.dueAt ? `due ${fmtDate(t.dueAt)}` : 'no due date'}
                        {t.notes ? ` · ${t.notes}` : ''}
                      </div>
                    </div>
                  </div>
                  <button className="btn btn-sm" onClick={() => void deleteTask(t)}>
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card">
          <strong>Calendar</strong>
          <p className="small muted">Agenda view — events sorted by start time.</p>

          <div className="field">
            <label className="label" htmlFor="ev-title">
              New event
            </label>
            <input
              id="ev-title"
              className="input"
              value={evTitle}
              onChange={(e) => setEvTitle(e.target.value)}
              placeholder="Event title"
            />
          </div>
          <div className="row-between">
            <div className="field" style={{ flex: 1, marginRight: 8 }}>
              <label className="label" htmlFor="ev-start">
                Starts
              </label>
              <input
                id="ev-start"
                type="datetime-local"
                className="input"
                value={evStart}
                onChange={(e) => setEvStart(e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="label" htmlFor="ev-end">
                Ends
              </label>
              <input
                id="ev-end"
                type="datetime-local"
                className="input"
                value={evEnd}
                onChange={(e) => setEvEnd(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="ev-notes">
              Notes (optional)
            </label>
            <input
              id="ev-notes"
              className="input"
              value={evNotes}
              onChange={(e) => setEvNotes(e.target.value)}
              placeholder="Location, agenda…"
            />
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => void addEvent()}>
            Add event
          </button>

          <div className="mt">
            {events.length === 0 ? (
              <p className="small muted">No events scheduled.</p>
            ) : (
              events.map((e) => (
                <div key={e.id} className="row-between" style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                  <div>
                    <strong>{e.title}</strong>
                    <div className="small muted">
                      {fmtDay(e.startsAt)} · {fmtTime(e.startsAt)} – {fmtTime(e.endsAt)}
                      {e.notes ? ` · ${e.notes}` : ''}
                    </div>
                  </div>
                  <button className="btn btn-sm" onClick={() => void deleteEvent(e)}>
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
