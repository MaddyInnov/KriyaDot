// SPDX-License-Identifier: Apache-2.0
// Marketplace HTTP API. Mounted by the integrator (routes.ts), e.g.:
//
//   import { registerMarketplaceRoutes } from './marketplace.js';
//   const marketplaceRouter = express.Router();
//   registerMarketplaceRoutes(marketplaceRouter, {
//     config, governance,
//     dataDir: config.dataDir,
//     registry: new MarketplaceRegistry(join(registryDir, 'registry.json')),
//     installer: new MarketplaceInstaller(join(config.dataDir, 'marketplace')),
//     revenue: new RevenueLedger(join(config.dataDir, 'marketplace.db')),
//   });
//   app.use('/api/marketplace', marketplaceRouter);
//
// Routes (router mounted at /api/marketplace):
//   GET    /                        → browse entries (?kind=bot&q=…&tag=…)
//   GET    /:id                     → one entry
//   POST   /:id/install             → install bot/skill/workflow immediately;
//                                      MCP servers return 202 with an approval id
//                                      (deny-by-default: nothing is written)
//   POST   /:id/install/confirm     → { approvalId } → completes an approved
//                                      MCP install (approval must be 'approved')
//   GET    /revenue/creators        → per-creator summaries
//   GET    /revenue/creators/:name  → summary + ledger lines
//   POST   /revenue/usage           → { creator, entryId, tokens }
//
// Trust: MCP server installs ALWAYS go through the governance approval
// inbox. The installer additionally refuses to write an MCP server without
// a one-time token (defense in depth).

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  bootstrapFirstRun,
  getBundle,
  installBundle,
  isMcpInstallApprovalRequired,
  listBundles,
  MarketplaceInstaller,
  MCP_INSTALL_TOOL,
  scaffoldSkill,
} from '@mvp/marketplace';
import { join } from 'node:path';
import type { MarketplaceKind } from '@mvp/marketplace';
import { MarketplaceRegistry } from '@mvp/marketplace';
import { RevenueLedger } from '@mvp/marketplace';
import type { GovernanceGateway } from '@mvp/governance';
import type { RouteDeps } from './routes.js';

export interface MarketplaceDeps extends Pick<RouteDeps, 'config' | 'governance'> {
  dataDir: string;
  registry: MarketplaceRegistry;
  installer: MarketplaceInstaller;
  revenue: RevenueLedger;
}

const VALID_KINDS: ReadonlySet<string> = new Set(['bot', 'skill', 'workflow', 'mcp-server', 'capability']);

export function registerMarketplaceRoutes(router: Router, deps: MarketplaceDeps): void {
  const { registry, installer, revenue, governance } = deps;

  router.get('/', (_req: Request, res: Response) => {
    try {
      const { kind, q, tag } = _req.query;
      if (kind !== undefined && (typeof kind !== 'string' || !VALID_KINDS.has(kind))) {
        res.status(400).json({ error: 'query "kind" must be bot|skill|workflow|mcp-server' });
        return;
      }
      const entries = registry.list({
        kind: kind as MarketplaceKind | undefined,
        q: typeof q === 'string' ? q : undefined,
        tag: typeof tag === 'string' ? tag : undefined,
      });
      res.json(entries);
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list marketplace entries') });
    }
  });

  // -- Specialist packaging (Octomind parity): bundles, first-run
  // bootstrap, and the skill authoring scaffold. Registered before
  // the /:id routes so 'bundles'/'bootstrap' are not captured as ids.
  router.get('/bundles', (_req: Request, res: Response) => {
    res.json({ ok: true, bundles: listBundles() });
  });

  router.post('/bundles/:id/install', (req: Request, res: Response) => {
    const bundle = getBundle(req.params.id);
    if (!bundle) {
      res.status(404).json({ error: `Unknown bundle "${req.params.id}"` });
      return;
    }
    try {
      const result = installBundle(bundle, registry, installer);
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'bundle install failed') });
    }
  });

  router.post('/bootstrap', (_req: Request, res: Response) => {
    try {
      const result = bootstrapFirstRun({ dataDir: deps.dataDir, registry, installer });
      res.status(result.alreadyBootstrapped ? 200 : 201).json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'bootstrap failed') });
    }
  });

  router.post('/scaffold-skill', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { slug?: unknown; name?: unknown; description?: unknown };
    try {
      if (typeof body.slug !== 'string' || typeof body.name !== 'string' || typeof body.description !== 'string') {
        throw new Error('Body must be { slug, name, description } (strings)');
      }
      // The runtime loads user skills from <dataDir>/skills — the
      // scaffold lands exactly where the loader will pick it up.
      const path = scaffoldSkill(join(deps.dataDir, 'skills'), {
        slug: body.slug,
        name: body.name,
        description: body.description,
      });
      res.status(201).json({ ok: true, path });
    } catch (err) {
      res.status(400).json({ error: errMessage(err, 'scaffold failed') });
    }
  });

  router.get('/revenue/creators', (_req: Request, res: Response) => {
    try {
      res.json({
        creators: revenue.listCreators().map((c) => revenue.creatorSummary(c)),
        platformEarningsCents: revenue.platformEarningsCents(),
      });
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to read revenue summary') });
    }
  });

  router.get('/revenue/creators/:name', (req: Request, res: Response) => {
    try {
      const name = req.params.name;
      res.json({
        summary: revenue.creatorSummary(name),
        ledger: revenue.ledgerFor(name),
      });
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to read creator revenue') });
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    const entry = registry.getById(req.params.id);
    if (!entry) {
      res.status(404).json({ error: `unknown marketplace entry: ${req.params.id}` });
      return;
    }
    res.json(entry);
  });

  router.post('/:id/install', (req: Request, res: Response) => {
    try {
      const entry = registry.getById(req.params.id);
      if (!entry) {
        res.status(404).json({ error: `unknown marketplace entry: ${req.params.id}` });
        return;
      }
      if (entry.kind === 'mcp-server') {
        // Deny-by-default: request human approval, write nothing yet.
        const approvalId = governance.requestApproval(
          MCP_INSTALL_TOOL,
          {
            entryId: entry.id,
            entryName: entry.name,
            version: entry.version,
            creator: entry.creator,
            untrusted: entry.untrusted,
            command: (entry.payload as { command?: string }).command ?? null,
            requiredEnv: (entry.payload as { requiredEnv?: string[] }).requiredEnv ?? [],
          },
          { sessionId: 'marketplace', botId: 'marketplace', actor: 'user' },
        );
        res.status(202).json({
          gated: true,
          approvalId,
          message:
            'MCP server install requires approval. Approve it in the approvals inbox, then POST to /:id/install/confirm with { approvalId }.',
        });
        return;
      }
      const result = installer.install(entry, {
        overwrite: (req.body as { overwrite?: unknown } | undefined)?.overwrite === true,
      });
      revenue.recordInstall(entry.creator, entry.id, entry.kind);
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to install marketplace entry') });
    }
  });

  router.post('/:id/install/confirm', (req: Request, res: Response) => {
    try {
      const entry = registry.getById(req.params.id);
      if (!entry) {
        res.status(404).json({ error: `unknown marketplace entry: ${req.params.id}` });
        return;
      }
      if (entry.kind !== 'mcp-server') {
        res.status(400).json({ error: 'confirm is only for mcp-server installs' });
        return;
      }
      const body = (req.body ?? {}) as { approvalId?: unknown };
      if (typeof body.approvalId !== 'string' || body.approvalId.length === 0) {
        res.status(400).json({ error: 'body "approvalId" is required' });
        return;
      }
      const approval = governance.getApproval(body.approvalId);
      if (!approval || approval.toolName !== MCP_INSTALL_TOOL) {
        res.status(404).json({ error: `unknown approval: ${body.approvalId}` });
        return;
      }
      if (approval.status !== 'approved') {
        installer.revokeMcpApprovalTokens(entry.id);
        res.status(403).json({
          error: `MCP install denied: approval ${body.approvalId} is ${approval.status}`,
        });
        return;
      }
      // Approved by a human in the governance inbox → mint the one-time
      // token and complete the install.
      const token = installer.issueMcpApprovalToken(entry.id, approval.id);
      const result = installer.install(entry, { mcpApprovalToken: token });
      revenue.recordInstall(entry.creator, entry.id, entry.kind);
      res.status(201).json(result);
    } catch (err) {
      if (isMcpInstallApprovalRequired(err)) {
        res.status(403).json({ error: errMessage(err, 'MCP install not approved') });
        return;
      }
      res.status(500).json({ error: errMessage(err, 'failed to confirm MCP install') });
    }
  });

  router.post('/revenue/usage', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { creator?: unknown; entryId?: unknown; tokens?: unknown };
      if (typeof body.creator !== 'string' || body.creator.length === 0) {
        res.status(400).json({ error: 'body "creator" is required' });
        return;
      }
      if (typeof body.entryId !== 'string' || body.entryId.length === 0) {
        res.status(400).json({ error: 'body "entryId" is required' });
        return;
      }
      if (typeof body.tokens !== 'number' || !Number.isFinite(body.tokens) || body.tokens < 0) {
        res.status(400).json({ error: 'body "tokens" must be a non-negative number' });
        return;
      }
      revenue.recordUsage(body.creator, body.entryId, Math.floor(body.tokens));
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to record usage') });
    }
  });
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// Re-export the package types the integrator may need to construct deps.
export { MarketplaceInstaller, MarketplaceRegistry, RevenueLedger };
