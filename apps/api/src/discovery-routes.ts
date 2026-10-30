// SPDX-License-Identifier: Apache-2.0
/**
 * Intent-search surface (Octomind parity #166).
 *
 * The runtime ranker `discoverByIntent` existed but its only consumer
 * ranked skills for auto-activation. This module exposes it over the
 * full discoverable catalog — bots, skills, MCP servers and
 * capabilities — as:
 *
 *   POST /discovery/search { intent, kinds?, topK?, minScore? }
 *     → { ok, intent, hits: [{ item: {kind,id,name,description}, score }] }
 *
 * plus a tool-facing variant: `createIntentSearchTool(deps)` returns a
 * ToolDefinition (`discover_by_intent`) the host can register so agents
 * can search by intent mid-turn.
 *
 * The catalog + embedder are host-injected. The embedder seam matches
 * the runtime's SyncEmbedder (embed(texts) => vectors); tests inject a
 * fake embedder — no network, no model download.
 *
 * HOST WIRING (parent): mount at '/api' —
 *   app.use('/api', createDiscoveryRouter({ items: () => catalog(), embedder }))
 * and optionally register createIntentSearchTool(...) in tool-registry.
 */

import express, { type Router } from 'express';
import { discoverByIntent, type DiscoverableItem, type DiscoverableKind } from '@mvp/agent-runtime';
import type { SyncEmbedder } from '@mvp/agent-runtime';
import type { ToolDefinition } from '@mvp/agent-runtime';

export interface DiscoveryDeps {
  /** The full discoverable catalog (bots + skills + mcp + capabilities). */
  items: () => DiscoverableItem[] | Promise<DiscoverableItem[]>;
  embedder: SyncEmbedder;
}

const KINDS: DiscoverableKind[] = ['bot', 'skill', 'mcp', 'capability'];

export async function searchByIntent(
  deps: DiscoveryDeps,
  input: { intent: string; kinds?: string[]; topK?: number; minScore?: number },
) {
  const all = await deps.items();
  const kinds = (input.kinds && input.kinds.length ? input.kinds : KINDS).filter((k): k is DiscoverableKind =>
    (KINDS as string[]).includes(k),
  );
  const items = all.filter((i) => kinds.includes(i.kind));
  return discoverByIntent(input.intent, items, deps.embedder, {
    ...(typeof input.topK === 'number' ? { topK: input.topK } : {}),
    ...(typeof input.minScore === 'number' ? { minScore: input.minScore } : {}),
  });
}

export function createDiscoveryRouter(deps: DiscoveryDeps): Router {
  const router = express.Router();
  router.post('/discovery/search', async (req, res) => {
    const body = (req.body ?? {}) as { intent?: unknown; kinds?: unknown; topK?: unknown; minScore?: unknown };
    if (typeof body.intent !== 'string' || !body.intent.trim()) {
      res.status(400).json({ error: 'intent (string) is required' });
      return;
    }
    try {
      const hits = await searchByIntent(deps, {
        intent: body.intent,
        kinds: Array.isArray(body.kinds) ? body.kinds.filter((k): k is string => typeof k === 'string') : undefined,
        topK: typeof body.topK === 'number' ? body.topK : undefined,
        minScore: typeof body.minScore === 'number' ? body.minScore : undefined,
      });
      res.json({ ok: true, intent: body.intent, hits });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}

/** Tool-facing variant for the tool registry. */
export function createIntentSearchTool(deps: DiscoveryDeps): ToolDefinition {
  return {
    name: 'discover_by_intent',
    description:
      'Search bots, skills, MCP servers and capabilities by intent (semantic ranking). Use to find the right specialist/capability for a task instead of guessing names.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string', enum: KINDS } },
        topK: { type: 'number' },
      },
      required: ['intent'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const hits = await searchByIntent(deps, {
        intent: String(args.intent ?? ''),
        kinds: Array.isArray(args.kinds) ? (args.kinds as string[]) : undefined,
        topK: typeof args.topK === 'number' ? args.topK : undefined,
      });
      return { hits: hits.map((h) => ({ kind: h.item.kind, id: h.item.id, name: h.item.name, description: h.item.description, score: h.score })) };
    },
  };
}
