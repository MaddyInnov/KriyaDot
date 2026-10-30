// SPDX-License-Identifier: Apache-2.0
// DA-1 — One-shot "download my data" export.
//
// POST /api/data-export builds ONE zip archive containing the user's
// transcripts, workspace files, recordings, memory stores and a settings
// manifest, writes it under <workspaceDir>/exports/, and returns an
// expiring download link minted through the FL-7 file-link rail
// (FileLinkService — approval-gated exactly like every other file link;
// with no governance gateway wired, `confirmed: true` is required).
//
// Secret discipline matches workspace backup: anything whose basename
// looks like a vault / token / credential / key file is EXCLUDED and the
// exclusion is listed in the export manifest (secretExclusionReason from
// workspace-backup.ts). The archive never contains provider keys, the
// machine key, OAuth caches, or the vault.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Router, type Request, type Response } from 'express';
import JSZip from 'jszip';
import { FileLinkService, type FileLink } from './file-links.js';
import { secretExclusionReason, type ExcludedFile } from './workspace-backup.js';
import { LifecycleAuditLog } from './lifecycle-approval.js';

export const DATA_EXPORT_FORMAT = 'kriyadot.data-export';
export const DATA_EXPORT_VERSION = '1';
export const EXPORTS_DIR_NAME = 'exports';

export type DataExportCategory = 'transcripts' | 'files' | 'recordings' | 'memory' | 'settings';
export const DATA_EXPORT_CATEGORIES: readonly DataExportCategory[] = [
  'transcripts',
  'files',
  'recordings',
  'memory',
  'settings',
];

/** Data-dir entries (files or dirs) that make up each non-files category. */
const CATEGORY_SOURCES: Record<Exclude<DataExportCategory, 'files'>, string[]> = {
  transcripts: [
    'bot-conversations.db',
    'chat-threads.db',
    'group-chats.db',
    'message-threads.db',
    'message-reactions.db',
    'chat-queue.db',
  ],
  recordings: ['recordings.db', 'recordings'],
  memory: ['omni.db', 'omni-memory', 'memory-fabric.db', 'knowledge.db', 'kb'],
  settings: ['preferences.db', 'spaces.json', 'bots', 'brand.json'],
};

export interface ExportManifestFile {
  /** Archive path, e.g. `transcripts/bot-conversations.db`. */
  path: string;
  category: DataExportCategory;
  size: number;
  sha256: string;
}

export interface DataExportManifest {
  format: typeof DATA_EXPORT_FORMAT;
  version: string;
  createdAt: string;
  categories: DataExportCategory[];
  files: ExportManifestFile[];
  excluded: ExcludedFile[];
  settings: {
    /** Non-secret settings snapshot: file names + sizes only, never values. */
    note: string;
    entries: string[];
  };
}

export interface DataExportResult {
  /** Workspace-relative archive path, e.g. `exports/kriyadot-export-….zip`. */
  archivePath: string;
  manifest: DataExportManifest;
  link: FileLink;
  /** One-time file-link token (FL-7: returned exactly once, at creation). */
  linkToken: string;
  /** Public path of the expiring download link, e.g. `/f/<token>`. */
  linkPath: string;
}

export interface DataExportDeps {
  dataDir: string;
  workspaceDir: string;
  fileLinks?: FileLinkService;
  auditLog?: LifecycleAuditLog;
  now?: () => Date;
}

interface Collected {
  absPath: string;
  archivePath: string;
  category: DataExportCategory;
}

export class DataExportService {
  private readonly dataDir: string;
  private readonly workspaceDir: string;
  private readonly fileLinks: FileLinkService;
  private readonly auditLog: LifecycleAuditLog;
  private readonly nowFn: () => Date;

  constructor(deps: DataExportDeps) {
    this.dataDir = deps.dataDir;
    this.workspaceDir = deps.workspaceDir;
    this.fileLinks = deps.fileLinks ?? new FileLinkService(deps.dataDir);
    this.auditLog = deps.auditLog ?? new LifecycleAuditLog(deps.dataDir);
    this.nowFn = deps.now ?? (() => new Date());
  }

  private collect(
    rootDir: string,
    archivePrefix: string,
    category: DataExportCategory,
    out: Collected[],
    excluded: ExcludedFile[],
  ): void {
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        const rel = relative(rootDir, abs).split(sep).join('/');
        if (entry.isDirectory()) {
          // The exports dir itself is never re-exported (no nesting bombs).
          if (category === 'files' && rel === EXPORTS_DIR_NAME) continue;
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const reason = secretExclusionReason(rel);
        if (reason) {
          excluded.push({ path: `${archivePrefix}/${rel}`, reason });
          continue;
        }
        out.push({ absPath: abs, archivePath: `${archivePrefix}/${rel}`, category });
      }
    };
    if (existsSync(rootDir)) walk(rootDir);
  }

  /**
   * Build the archive + expiring link. Throws when the file-link rail
   * refuses (approval required / not confirmed) — the archive is still
   * written, but no usable link exists until the rail approves one; the
   * error propagates so the caller sees the governance outcome.
   */
  async createExport(input: {
    categories?: DataExportCategory[];
    ttlMs?: number;
    confirmed?: boolean;
    createdBy?: string;
  }): Promise<DataExportResult> {
    const categories = (input.categories?.length ? input.categories : [...DATA_EXPORT_CATEGORIES]).filter(
      (c): c is DataExportCategory => (DATA_EXPORT_CATEGORIES as readonly string[]).includes(c),
    );
    if (categories.length === 0) throw new Error('at least one export category is required');

    const collected: Collected[] = [];
    const excluded: ExcludedFile[] = [];
    for (const category of categories) {
      if (category === 'files') {
        this.collect(this.workspaceDir, 'files', category, collected, excluded);
        continue;
      }
      for (const sourceName of CATEGORY_SOURCES[category]) {
        const abs = join(this.dataDir, sourceName);
        if (!existsSync(abs)) continue;
        if (statSync(abs).isDirectory()) {
          this.collect(abs, `${category}/${sourceName}`, category, collected, excluded);
        } else {
          const reason = secretExclusionReason(sourceName);
          if (reason) {
            excluded.push({ path: `${category}/${sourceName}`, reason });
          } else {
            collected.push({ absPath: abs, archivePath: `${category}/${sourceName}`, category });
          }
        }
      }
    }

    const zip = new JSZip();
    const manifestFiles: ExportManifestFile[] = [];
    for (const file of collected) {
      const bytes = readFileSync(file.absPath);
      zip.file(file.archivePath, bytes);
      manifestFiles.push({
        path: file.archivePath,
        category: file.category,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    const now = this.nowFn();
    const manifest: DataExportManifest = {
      format: DATA_EXPORT_FORMAT,
      version: DATA_EXPORT_VERSION,
      createdAt: now.toISOString(),
      categories,
      files: manifestFiles,
      excluded,
      settings: {
        note: 'Settings stores are exported as opaque database files; secret values (vault, provider keys, tokens) are never included — see `excluded`.',
        entries: manifestFiles.filter((f) => f.category === 'settings').map((f) => f.path),
      },
    };
    zip.file('export-manifest.json', JSON.stringify(manifest, null, 2));

    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const archiveName = `kriyadot-export-${stamp}.zip`;
    const exportsDir = join(this.workspaceDir, EXPORTS_DIR_NAME);
    mkdirSync(exportsDir, { recursive: true });
    const archiveBytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    writeFileSync(join(exportsDir, archiveName), archiveBytes);
    const archivePath = `${EXPORTS_DIR_NAME}/${archiveName}`;

    const created = this.fileLinks.create({
      kind: 'workspace',
      root: this.workspaceDir,
      pathOrUploadId: archivePath,
      label: 'KriyaDot data export',
      createdBy: input.createdBy,
      ttlMs: input.ttlMs,
      confirmed: input.confirmed,
    });

    this.auditLog.record('data.export', input.createdBy || 'api', {
      archivePath,
      categories,
      fileCount: manifestFiles.length,
      excludedCount: excluded.length,
      linkId: created.link.id,
      linkStatus: created.link.status,
    });

    return {
      archivePath,
      manifest,
      link: created.link,
      linkToken: created.token,
      linkPath: created.path,
    };
  }
}

// ---------------------------------------------------------------------------
// Routes — register-style: mount the returned router at /api
// (paths are /data-export).
// ---------------------------------------------------------------------------

export function createDataExportRouter(deps: DataExportDeps): Router {
  const service = new DataExportService(deps);
  const router = Router();

  router.post('/data-export', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        categories?: unknown;
        ttlHours?: unknown;
        confirmed?: unknown;
        createdBy?: unknown;
      };
      const result = await service.createExport({
        categories: Array.isArray(body.categories)
          ? (body.categories.filter((c) => typeof c === 'string') as DataExportCategory[])
          : undefined,
        ttlMs: typeof body.ttlHours === 'number' ? body.ttlHours * 3600_000 : undefined,
        confirmed: body.confirmed === true,
        createdBy: typeof body.createdBy === 'string' ? body.createdBy : undefined,
      });
      res.status(result.link.status === 'pending-approval' ? 202 : 201).json({
        ok: true,
        archivePath: result.archivePath,
        manifest: result.manifest,
        link: result.link,
        linkToken: result.linkToken,
        downloadPath: result.linkPath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'data export failed';
      res.status(/approval/i.test(message) ? 403 : 400).json({ error: message });
    }
  });

  return router;
}
