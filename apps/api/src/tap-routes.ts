// SPDX-License-Identifier: Apache-2.0
/**
 * Tap distribution + portable specialist publishing (Octomind parity
 * #103 / #153 / #171, API side).
 *
 * The marketplace package gained tap support (github / local / named
 * channel sources, SHA-256-verified portable manifests). This router
 * exposes it, plus the workflow leg of SkillHub-style network installs:
 *
 *   POST /taps/install
 *     { ref: 'github:owner/repo[@branch]' | 'local:/path' | 'channel:<name>' | 'owner/repo' }
 *     → installs every entry in the tap index (skills, workflows,
 *       bots, capabilities) through the marketplace installer. MCP
 *       entries stay approval-gated inside installTapEntries.
 *   POST /taps/workflows/install { packageUrl, sha256? }
 *     → download a workflow manifest (kriyadot.workflow JSON), verify
 *       its SHA-256 when one is known, parse it, and persist it via
 *       the host's saveWorkflow hook — the workflow twin of the
 *       SkillHub skill flow, with the same checksum discipline.
 *   POST /specialists/publish { entry } | { bundle, entries }
 *     → a portable manifest (JSON, checksummed). Portable manifests
 *       carry their own integrity proof, so installing one is NOT
 *       org-scoped: any holder of a valid manifest may install it.
 *   POST /specialists/install-manifest { manifest } (object or JSON text)
 *     → checksum-verified install via installPortableManifest.
 *   POST /published-bots/:id/export-manifest
 *     → turn a deployment-local published bot into a portable manifest
 *       (bridge from published-bots.ts; requires the host hook below).
 *
 * HOST WIRING (parent): mount at '/api' —
 *   app.use('/api', createTapRouter({
 *     installer, dataDir: config.dataDir,
 *     fetchText: async (url) => (await fetch(url)).text(),   // optional
 *     saveWorkflow: (def) => workflowStore.saveWorkflow(def), // optional
 *     publishedBotEntry: (id) => entryOrUndefined,            // optional
 *   }))
 */

import express, { type Router } from 'express';
import {
  createPortableManifest,
  installFromTap,
  installPortableManifest,
  resolveTapSource,
  serializePortableManifest,
  type MarketplaceEntry,
  type MarketplaceInstaller,
  type SkillBundle,
} from '@mvp/marketplace';
import { parseWorkflowFile, type WorkflowDefinition } from '@mvp/workflows';
import { sha256Hex } from './skillhub.js';

export interface TapRouterDeps {
  installer: MarketplaceInstaller;
  dataDir: string;
  /** Injectable fetcher (tests pass fakes — no real network). */
  fetchText?: (url: string) => Promise<string>;
  saveWorkflow?: (def: WorkflowDefinition) => unknown | Promise<unknown>;
  /** Bridge to published-bots: published id → marketplace entry form. */
  publishedBotEntry?: (id: string) => MarketplaceEntry | undefined;
}

const defaultFetchText = async (url: string): Promise<string> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  return res.text();
};

export function createTapRouter(deps: TapRouterDeps): Router {
  const router = express.Router();
  const fetcher = deps.fetchText ?? defaultFetchText;

  router.post('/taps/install', async (req, res) => {
    const ref = typeof (req.body as { ref?: unknown })?.ref === 'string' ? (req.body as { ref: string }).ref : '';
    if (!ref) { res.status(400).json({ error: 'ref is required (github:owner/repo | local:/path | channel:<name> | owner/repo)' }); return; }
    try {
      const source = resolveTapSource(ref, `${deps.dataDir}/tap-channels.json`);
      const report = await installFromTap(source, { fetcher, installer: deps.installer, channelsPath: `${deps.dataDir}/tap-channels.json` });
      res.status(201).json({ ok: true, report });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/taps/workflows/install', async (req, res) => {
    const body = (req.body ?? {}) as { packageUrl?: unknown; sha256?: unknown };
    if (typeof body.packageUrl !== 'string' || !/^https?:\/\//.test(body.packageUrl)) {
      res.status(400).json({ error: 'packageUrl (http/https) is required' });
      return;
    }
    try {
      const text = await fetcher(body.packageUrl);
      const digest = sha256Hex(text);
      if (typeof body.sha256 === 'string' && body.sha256.toLowerCase() !== digest) {
        res.status(400).json({ error: `workflow package checksum mismatch: expected ${body.sha256}, got ${digest}. Nothing was installed.` });
        return;
      }
      const def = parseWorkflowFile(text);
      if (deps.saveWorkflow) await deps.saveWorkflow(def);
      res.status(201).json({ ok: true, workflow: def, sha256: digest, persisted: !!deps.saveWorkflow });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/specialists/publish', (req, res) => {
    const body = (req.body ?? {}) as { entry?: MarketplaceEntry; bundle?: SkillBundle; entries?: MarketplaceEntry[] };
    try {
      const manifest = body.entry
        ? createPortableManifest({ entry: body.entry })
        : body.bundle && body.entries
          ? createPortableManifest({ bundle: body.bundle, entries: body.entries })
          : null;
      if (!manifest) { res.status(400).json({ error: 'Provide { entry } or { bundle, entries }' }); return; }
      res.status(201).json({ ok: true, manifest, serialized: serializePortableManifest(manifest) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/specialists/install-manifest', (req, res) => {
    const body = (req.body ?? {}) as { manifest?: unknown };
    try {
      const manifestText = typeof body.manifest === 'string' ? body.manifest : JSON.stringify(body.manifest ?? {});
      // parsePortableManifest (inside installPortableManifest) verifies
      // the SHA-256 checksum — a tampered manifest installs nothing.
      const result = installPortableManifest(manifestText, deps.installer);
      res.status(201).json({ ok: true, installed: result.installed.length, gatedMcp: result.gatedMcp });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/published-bots/:id/export-manifest', (req, res) => {
    if (!deps.publishedBotEntry) { res.status(501).json({ error: 'published-bot export is not wired on this host' }); return; }
    const entry = deps.publishedBotEntry(req.params.id);
    if (!entry) { res.status(404).json({ error: `unknown published bot "${req.params.id}"` }); return; }
    try {
      const manifest = createPortableManifest({ entry });
      res.json({ ok: true, manifest, serialized: serializePortableManifest(manifest) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
