// SPDX-License-Identifier: Apache-2.0
// Agent tool surface for ideas (I-4 enforcement, tool layer).
//
// The `manage_ideas` tool deliberately has NO dismiss action: dismissal
// is user-only, enforced twice — the action does not exist here, and
// IdeaStore.dismiss() refuses any non-user actor at the store layer.
// Agents can propose (create), inspect (list), start work (run) and
// report completion (complete) — the human keeps the shelve decision.
//
// Follows the tools.ts pattern: the factory takes the modules dataDir
// and each handler call opens the shared ModuleDb for that directory.

import { join } from 'node:path';
import type { ToolDefinition } from '@mvp/agent-runtime';
import { ModuleDb } from '../db.js';
import { IdeaStore } from './index.js';
import { IdeaRunTracker } from './runs.js';

export function ideaTools(dataDir: string): ToolDefinition[] {
  const manage: ToolDefinition = {
    name: 'manage_ideas',
    description:
      'Work with the user\'s idea cards. Actions: list (optionally by status), create ' +
      '(title, description), run (start working an idea; returns a runId bound to the card), ' +
      'progress (runId, pct, note — live progress shown on the card), complete_run (runId), ' +
      'complete (ideaId, for runs started outside chat). NOTE: agents cannot dismiss ideas — ' +
      'dismissal is reserved for the user.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'run', 'progress', 'complete_run', 'complete'] },
        ideaId: { type: 'string', description: 'Idea id (for run/complete)' },
        runId: { type: 'string', description: 'Run id (for progress/complete_run)' },
        title: { type: 'string', description: 'Idea title (for create)' },
        description: { type: 'string', description: 'Idea description (for create)' },
        status: { type: 'string', enum: ['new', 'active', 'done', 'dismissed', 'expired'] },
        pct: { type: 'number', description: 'Progress 0–100 (for progress)' },
        note: { type: 'string', description: 'Progress note (for progress)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    mutating: true,
    handler: async (args) => {
      const mdb = new ModuleDb(join(dataDir, 'muse-modules.db'));
      try {
        const store = new IdeaStore(mdb);
        const runs = new IdeaRunTracker(mdb);
        const action = String(args.action ?? '');
        switch (action) {
          case 'list':
            return { ideas: store.list(args.status as never) };
          case 'create':
            return store.create({ title: String(args.title ?? ''), description: args.description as string | undefined, source: 'manual' });
          case 'run':
            return runs.start(String(args.ideaId ?? ''));
          case 'progress':
            return runs.progress(String(args.runId ?? ''), Number(args.pct ?? 0), String(args.note ?? ''));
          case 'complete_run':
            return runs.complete(String(args.runId ?? ''), String(args.note ?? '') || 'run completed');
          case 'complete':
            return store.complete(String(args.ideaId ?? ''));
          default:
            throw new Error(`unknown manage_ideas action: ${action}`);
        }
      } finally {
        mdb.close();
      }
    },
  };
  return [manage];
}
