// SPDX-License-Identifier: Apache-2.0
// Agent tools for the managed knowledge bases (kb.ts).
//
// The legacy `kb_search` tool lives in @mvp/muse-modules (tools.ts) over
// its own store — not owned by this workstream — so it is NOT edited here.
// Instead these ToolDefinitions are exported for the parent to merge into
// the tool registry alongside it:
//
//   import { createKbTools } from './kb-tools.js';
//   for (const tool of createKbTools(new KbStore(config.dataDir))) {
//     toolRegistry.set(tool.name, tool);
//   }
//
// `kb_search_managed` returns structured citations
// { kbId, docId, docTitle, chunkIndex, excerpt, score } so chat can render
// clickable sources. Tool turns run as the local single user by default
// ('default-user'), matching the loopback convention; hosts with real
// multi-user turns pass resolveActor.

import type { ToolDefinition } from '@mvp/agent-runtime';
import { KbStore, type KbActor } from './kb.js';

export interface KbToolsOptions {
  /** Actor the tool acts as (share enforcement). Default: the local single user. */
  resolveActor?: (ctx: { botId: string; sessionId: string }) => KbActor;
}

export function createKbTools(store: KbStore, opts: KbToolsOptions = {}): ToolDefinition[] {
  const actorFor = (ctx: { botId: string; sessionId: string }): KbActor =>
    opts.resolveActor?.(ctx) ?? { userId: 'default-user' };

  const searchManaged: ToolDefinition = {
    name: 'kb_search_managed',
    description:
      'Search the managed knowledge bases (named corpora) the user can access. ' +
      'Returns cited excerpts: each result carries kbId, docId, docTitle, chunkIndex and excerpt ' +
      'so sources can be cited in the answer. Optionally scope to one corpus with kbId.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        kbId: { type: 'string', description: 'Optional corpus id to scope the search.' },
        topK: { type: 'number', description: 'Max results (1-20, default 5).' },
      },
      required: ['query'],
    },
    handler: async (args, ctx) => {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query.trim()) return { citations: [], note: 'query is required' };
      const citations = store.search(actorFor(ctx), query, {
        kbId: typeof args.kbId === 'string' ? args.kbId : undefined,
        topK: typeof args.topK === 'number' ? args.topK : undefined,
      });
      return { citations };
    },
  };

  const listManaged: ToolDefinition = {
    name: 'kb_list_managed',
    description: 'List the managed knowledge bases (corpora) visible to the user, with their ids.',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const corpora = store
        .listCorpora(actorFor(ctx))
        .map((c) => ({ id: c.id, name: c.name, description: c.description, embeddingProvider: c.embeddingProvider }));
      return { corpora };
    },
  };

  return [searchManaged, listManaged];
}
