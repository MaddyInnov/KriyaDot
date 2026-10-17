// SPDX-License-Identifier: Apache-2.0
// Teach-by-recording — record user UI actions, convert to a workflow.
//
// The user clicks "Record", performs actions in the web UI (the frontend
// captures click/input/navigate events), then clicks "Stop". The recording
// is converted into a workflow definition with browser-automation steps.
//
// Storage: <dataDir>/recordings.db (node:sqlite).

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { openDb } from '@mvp/agent-runtime';

export type RecordedEventType =
  | 'click'
  | 'input'
  | 'navigate'
  | 'wait'
  // Computer-view events (teach-by-recording for the per-bot computer view):
  // coordinate-based user input captured while demonstrating a task. These
  // compile to computer_* tool nodes in a workflow definition.
  | 'computer_click'
  | 'computer_type'
  | 'computer_key'
  | 'computer_screenshot'
  | 'computer_wait';

export interface RecordedEvent {
  type: RecordedEventType;
  /** CSS selector for click/input. */
  selector?: string;
  /** Value for input events. */
  value?: string;
  /** URL for navigate events. */
  url?: string;
  /** Milliseconds to wait (for wait events). */
  ms?: number;
  /** Click coordinates in physical pixels (computer_click). */
  x?: number;
  /** Click coordinates in physical pixels (computer_click). */
  y?: number;
  /** Text typed (computer_type). */
  text?: string;
  /** Named key pressed, e.g. 'Enter' (computer_key). */
  key?: string;
  timestamp: number;
}

export interface Recording {
  id: string;
  name: string;
  status: 'recording' | 'stopped' | 'converted';
  events: RecordedEvent[];
  createdAt: number;
  stoppedAt?: number;
  workflowId?: string;
}

interface RecordingRow {
  id: string;
  name: string;
  status: string;
  events_json: string;
  created_at: number;
  stopped_at: number | null;
  workflow_id: string | null;
}

function rowToRecording(r: RecordingRow): Recording {
  return {
    id: r.id,
    name: r.name,
    status: r.status as Recording['status'],
    events: JSON.parse(r.events_json) as RecordedEvent[],
    createdAt: r.created_at,
    stoppedAt: r.stopped_at ?? undefined,
    workflowId: r.workflow_id ?? undefined,
  };
}

export class RecordingStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'recordings.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        events_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        stopped_at INTEGER,
        workflow_id TEXT
      );
    `);
  }

  start(name: string): Recording {
    const rec: Recording = {
      id: randomUUID(),
      name: name.trim().slice(0, 100) || 'Untitled recording',
      status: 'recording',
      events: [],
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO recordings (id, name, status, events_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(rec.id, rec.name, rec.status, '[]', rec.createdAt);
    return rec;
  }

  addEvents(id: string, events: RecordedEvent[]): Recording | undefined {
    const rec = this.get(id);
    if (!rec || rec.status !== 'recording') return undefined;
    const all = [...rec.events, ...events.map((e) => ({ ...e, timestamp: e.timestamp || Date.now() }))];
    this.db.prepare('UPDATE recordings SET events_json = ? WHERE id = ?').run(JSON.stringify(all), id);
    return this.get(id);
  }

  stop(id: string): Recording | undefined {
    const rec = this.get(id);
    if (!rec || rec.status !== 'recording') return undefined;
    this.db.prepare("UPDATE recordings SET status = 'stopped', stopped_at = ? WHERE id = ?").run(Date.now(), id);
    return this.get(id);
  }

  get(id: string): Recording | undefined {
    const row = this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as unknown as RecordingRow | undefined;
    return row ? rowToRecording(row) : undefined;
  }

  list(): Recording[] {
    const rows = this.db.prepare('SELECT * FROM recordings ORDER BY created_at DESC').all() as unknown as RecordingRow[];
    return rows.map(rowToRecording);
  }

  markConverted(id: string, workflowId: string): void {
    this.db.prepare("UPDATE recordings SET status = 'converted', workflow_id = ? WHERE id = ?").run(workflowId, id);
  }
}

/**
 * Convert a recording into a workflow definition.
 * Each recorded event becomes a browser-automation step.
 */
export function recordingToWorkflow(rec: Recording): {
  name: string;
  description: string;
  trigger: { type: 'manual' };
  steps: Array<{ id: string; type: string; config: Record<string, unknown> }>;
} {
  const steps = rec.events.map((e, i) => {
    const base = { id: `step-${i + 1}`, type: 'browser', config: {} as Record<string, unknown> };
    if (e.type === 'navigate' && e.url) {
      base.config = { action: 'goto', url: e.url };
    } else if (e.type === 'click' && e.selector) {
      base.config = { action: 'click', selector: e.selector };
    } else if (e.type === 'input' && e.selector) {
      base.config = { action: 'fill', selector: e.selector, value: e.value ?? '' };
    } else if (e.type === 'wait') {
      base.config = { action: 'wait', ms: e.ms ?? 1000 };
    }
    return base;
  });
  return {
    name: rec.name,
    description: `Recorded workflow: ${rec.events.length} steps captured from UI interaction.`,
    trigger: { type: 'manual' },
    steps,
  };
}
