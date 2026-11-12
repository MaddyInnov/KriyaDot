// SPDX-License-Identifier: Apache-2.0
// Chat capture for the parked-ideas notebook (Timon parity B6).
//
// `park_idea` is the lightweight capture path: mid-conversation the user
// (or the bot, on the user's behalf) can say "park that idea" and it
// lands in the notebook instead of evaporating — or worse, becoming a
// task nobody asked to run yet.
//
// WRITE-ONLY INTO IDEAS, BY CONSTRUCTION: this module receives ONLY a
// ParkedIdeaStore. It holds no TaskStore, no routine store, no scheduler
// handle, so the tool cannot create a task, schedule a routine, or make
// an idea actionable even if a prompt tries to talk it into doing so.
// Turning a parked idea into work remains the human's explicit
// "Action this idea" action in the UI (see parked-ideas.ts header for
// why that separation is structural, not a flag).
//
// Host wiring (coordinator), beside the other tool registrations:
//   for (const tool of createParkedIdeaTools(new ParkedIdeaStore(config.dataDir))) {
//     if (!toolRegistry.has(tool.name)) toolRegistry.set(tool.name, tool);
//   }

import type { ToolDefinition } from '@mvp/agent-runtime';
import { ParkedIdeaStore } from './parked-ideas.js';

export function createParkedIdeaTools(store: ParkedIdeaStore): ToolDefinition[] {
  const parkIdea: ToolDefinition = {
    name: 'park_idea',
    description:
      'Park an idea in the user\'s ideas notebook for later. Use when the user mentions an idea ' +
      'they are NOT asking to act on now ("someday…", "idea:", "we should sometime…"). ' +
      'Parking is inert: it creates NO task, NO routine and NO scheduled work — the idea sits ' +
      'in the notebook until the user explicitly actions it from the Workspace Ideas section. ' +
      'Do not use this for things the user wants done now; those belong in tasks/routines.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the idea.' },
        body: { type: 'string', description: 'Optional detail: context, why it might matter, links.' },
      },
      required: ['title'],
    },
    handler: async (args) => {
      const title = typeof args.title === 'string' ? args.title : '';
      if (!title.trim()) return { parked: false, error: 'a title is required to park an idea' };
      const idea = store.create({
        title,
        body: typeof args.body === 'string' ? args.body : undefined,
        source: 'chat',
      });
      return {
        parked: true,
        ideaId: idea.id,
        title: idea.title,
        note: 'Parked in the ideas notebook. It will not be acted on until the user actions it.',
      };
    },
  };

  return [parkIdea];
}
