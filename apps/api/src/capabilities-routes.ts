// SPDX-License-Identifier: Apache-2.0
// Capability registry endpoint (closure addendum ADD-2):
//
//   GET /api/capabilities        → { entries: [...], generatedAt, counts }
//   GET /api/capabilities?q=...  → { entries: [...ranked hits...],
//                                    generatedAt, query }
//
// The shape is a stable contract: the in-app Guide (addendum ADD-3)
// builds its walkthroughs from these entries, so `entries` always carries
// the full CapabilityEntry objects ({ id, name, whatItDoes, whenToUse,
// howToInvoke, kind, group, keywords }) and `generatedAt` always says when
// the underlying registry snapshot was built. Search results keep the same
// entry objects and add a `score` field per entry.
//
// HOST WIRING (index.ts):
//   app.use('/api/capabilities', createCapabilitiesRouter({ service: capabilityService }));

import express, { type Router } from 'express';
import type { CapabilityService } from './capabilities.js';

export interface CapabilitiesRoutesDeps {
  service: CapabilityService;
}

export function createCapabilitiesRouter(deps: CapabilitiesRoutesDeps): Router {
  const router = express.Router();

  router.get('/', (req, res) => {
    const registry = deps.service.getRegistry();
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 10;
      const hits = deps.service.search(q, { limit });
      res.json({
        entries: hits.map((h) => ({ ...h.entry, score: h.score })),
        generatedAt: registry.generatedAt,
        counts: registry.counts,
        query: q,
      });
      return;
    }
    res.json({
      entries: registry.entries,
      generatedAt: registry.generatedAt,
      counts: registry.counts,
    });
  });

  return router;
}
