// SPDX-License-Identifier: Apache-2.0
// Bulk operations (chat polish): delete many bots / threads in one call.
//
// HOST WIRING (parent):
//   app.use('/api', createBulkRouter({
//     deleteBot: (id) => ..., deleteThread: (id) => agentRuntime.sessionStore.deleteSession(id),
//     audit: (a, f) => governance.audit(a, f) }));
// Routes: POST /bulk/bots/delete · POST /bulk/threads/delete
// Body: { ids: string[] } → per-id results, never all-or-nothing.

import express from 'express';

export interface BulkRouterDeps {
  deleteBot?: (id: string) => boolean | Promise<boolean>;
  deleteThread?: (id: string) => boolean | Promise<boolean>;
  audit?: (action: string, fields: Record<string, unknown>) => void;
}

export interface BulkItemResult { id: string; ok: boolean; error?: string }

export const MAX_BULK_IDS = 200;

/** Validate an ids array; returns the cleaned ids or an error string. */
export function parseBulkIds(body: unknown): { ids?: string[]; error?: string } {
  const ids = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids) || ids.length === 0) return { error: 'body.ids must be a non-empty array of ids' };
  if (ids.length > MAX_BULK_IDS) return { error: `at most ${MAX_BULK_IDS} ids per call` };
  const cleaned: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id.trim() || id.length > 256) return { error: 'every id must be a non-empty string' };
    if (!cleaned.includes(id.trim())) cleaned.push(id.trim());
  }
  return { ids: cleaned };
}

async function runBulk(
  ids: string[],
  fn: (id: string) => boolean | Promise<boolean>,
): Promise<BulkItemResult[]> {
  const results: BulkItemResult[] = [];
  for (const id of ids) {
    try {
      const ok = await fn(id);
      results.push(ok ? { id, ok: true } : { id, ok: false, error: 'not found' });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

export function createBulkRouter(deps: BulkRouterDeps): express.Router {
  const router = express.Router();
  const make = (kind: 'bots' | 'threads', fn?: BulkRouterDeps['deleteBot']) =>
    async (req: express.Request, res: express.Response) => {
      if (!fn) { res.status(503).json({ ok: false, error: `${kind} deletion not configured` }); return; }
      const parsed = parseBulkIds(req.body ?? {});
      if (!parsed.ids) { res.status(400).json({ ok: false, error: parsed.error }); return; }
      const results = await runBulk(parsed.ids, fn);
      const deleted = results.filter((r) => r.ok).length;
      deps.audit?.(`bulk.${kind}.delete`, { detail: { requested: parsed.ids.length, deleted, results } });
      res.json({ ok: true, kind, requested: parsed.ids.length, deleted, failed: results.length - deleted, results });
    };
  router.post('/bulk/bots/delete', make('bots', deps.deleteBot));
  router.post('/bulk/threads/delete', make('threads', deps.deleteThread));
  return router;
}
