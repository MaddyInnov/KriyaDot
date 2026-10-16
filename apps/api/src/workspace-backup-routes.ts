// SPDX-License-Identifier: Apache-2.0
// Workspace backup / restore / rollback HTTP routes.
//
//   POST /backup            → download `.kriyadot-backup-<stamp>.zip`
//   POST /restore/dry-run   { archive: base64 } → diff (added/overwritten/
//                             unchanged + skipped-secret files)
//   POST /restore           { archive: base64, confirm: true } → automatic
//                             pre-restore snapshot, then apply
//   GET  /backups           → rollback snapshots (newest first)
//   POST /restore/rollback  { snapshot } → restore a pre-restore snapshot
//
// Secrets are NEVER in a backup: the engine's filename blocklist excludes
// the vault, wallet, provider keys, machine key, OAuth/connected-account
// caches and anything token/secret/credential-looking. Restore additionally
// refuses to write secret-looking paths even when a hand-crafted archive
// contains them, and never touches credentials that exist on disk.
//
// HOST WIRING (index.ts):
//   import { createWorkspaceBackupRouter } from './workspace-backup-routes.js';
//   app.use('/api/workspace', createWorkspaceBackupRouter({
//     dataDir: config.dataDir,
//     workspaceDir: config.workspaceDir,
//     audit: (action, fields) => governance.audit(action, fields),
//   }));

import express, { type Request, type Response, type Router } from 'express';
import {
  applyRestore,
  backupFilename,
  buildBackup,
  dryRunRestore,
  listBackupSnapshots,
  rollbackToSnapshot,
} from './workspace-backup.js';

export interface WorkspaceBackupRouteDeps {
  dataDir: string;
  workspaceDir: string;
  appVersion?: string;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

function archiveBuffer(body: Record<string, unknown>): Buffer | null {
  const raw = body.archive;
  if (typeof raw !== 'string' || !raw) return null;
  // Guard: express.json already caps at 150mb; reject absurd payloads early.
  if (raw.length > 200 * 1024 * 1024) return null;
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 0) return null;
    return buf;
  } catch {
    return null;
  }
}

export function createWorkspaceBackupRouter(deps: WorkspaceBackupRouteDeps): Router {
  const router = express.Router();
  const engine = { dataDir: deps.dataDir, workspaceDir: deps.workspaceDir, appVersion: deps.appVersion };

  /** One-click backup download. */
  router.post('/backup', async (_req: Request, res: Response) => {
    try {
      const { zip, manifest } = await buildBackup(engine);
      deps.audit('workspace.backup_created', {
        actor: 'api',
        detail: { files: manifest.files.length, excluded: manifest.excluded.length },
      });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${backupFilename(manifest.createdAt)}"`,
      );
      res.send(zip);
    } catch (err) {
      res.status(500).json(errorBody('backup failed', err instanceof Error ? err.message : String(err)));
    }
  });

  /** Dry-run: show the diff before touching anything. */
  router.post('/restore/dry-run', async (req: Request, res: Response) => {
    const buf = archiveBuffer((req.body ?? {}) as Record<string, unknown>);
    if (!buf) {
      res.status(400).json(errorBody('body.archive (base64 zip) is required'));
      return;
    }
    try {
      const diff = await dryRunRestore(engine, buf);
      res.json({ ok: true, diff });
    } catch (err) {
      res.status(400).json(errorBody('invalid backup archive', err instanceof Error ? err.message : String(err)));
    }
  });

  /** Apply a restore: snapshot first (automatic), then write. */
  router.post('/restore', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const buf = archiveBuffer(body);
    if (!buf) {
      res.status(400).json(errorBody('body.archive (base64 zip) is required'));
      return;
    }
    if (body.confirm !== true) {
      res.status(400).json(
        errorBody('restore is destructive: re-send with { confirm: true } after reviewing /restore/dry-run'),
      );
      return;
    }
    try {
      const result = await applyRestore(engine, buf);
      deps.audit('workspace.restored', {
        actor: 'api',
        detail: {
          added: result.added,
          overwritten: result.overwritten,
          skippedSecrets: result.skippedSecrets,
          snapshot: result.snapshot,
        },
      });
      res.json({
        ...result,
        note: 'A pre-restore snapshot was saved automatically — roll back with POST /restore/rollback if needed.',
      });
    } catch (err) {
      res.status(400).json(errorBody('restore failed', err instanceof Error ? err.message : String(err)));
    }
  });

  /** List rollback snapshots (newest first). */
  router.get('/backups', (_req: Request, res: Response) => {
    res.json({ ok: true, snapshots: listBackupSnapshots(deps.dataDir) });
  });

  /** Roll back to a pre-restore snapshot. */
  router.post('/restore/rollback', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const snapshot = typeof body.snapshot === 'string' ? body.snapshot : '';
    if (!snapshot) {
      res.status(400).json(errorBody('body.snapshot is required'));
      return;
    }
    try {
      const result = await rollbackToSnapshot(engine, snapshot);
      deps.audit('workspace.rollback', { actor: 'api', detail: { snapshot } });
      res.json({ snapshot, ...result });
    } catch (err) {
      res.status(400).json(errorBody('rollback failed', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}
