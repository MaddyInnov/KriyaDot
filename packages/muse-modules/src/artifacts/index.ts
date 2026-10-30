// SPDX-License-Identifier: Apache-2.0
// Durable documents/pages the agent builds (Muse parity): titled artifacts
// with markdown content and full version history. Every update creates a new
// immutable version; get() returns the latest.

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

export interface Artifact {
  id: string;
  title: string;
  version: number;
  /** Markdown content of the latest version. */
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactVersion {
  version: number;
  content: string;
  createdAt: number;
}

interface ArtifactRow {
  id: string;
  title: string;
  current_version: number;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  version: number;
  content: string;
  created_at: number;
}

const MAX_CONTENT_BYTES = 1024 * 1024; // 1 MiB per version

export class ArtifactStore {
  constructor(private readonly mdb: ModuleDb) {}

  create(input: { title: string; content: string }): Artifact {
    const title = (input.title ?? '').trim();
    if (!title) throw new ValidationError('artifact "title" must be a non-empty string');
    if (title.length > 200) throw new ValidationError('artifact "title" must be at most 200 characters');
    const content = requireContent(input.content);
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare(
        'INSERT INTO mm_artifacts (id, title, current_version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
      )
      .run(id, title, now, now);
    this.mdb.db
      .prepare(
        'INSERT INTO mm_artifact_versions (id, artifact_id, version, content, created_at) VALUES (?, ?, 1, ?, ?)',
      )
      .run(randomUUID(), id, content, now);
    return this.get(id);
  }

  get(id: string): Artifact {
    const row = this.mdb.db
      .prepare('SELECT id, title, current_version, created_at, updated_at FROM mm_artifacts WHERE id = ?')
      .get(id) as ArtifactRow | undefined;
    if (!row) throw new NotFoundError(`unknown artifact: ${id}`);
    const version = this.mdb.db
      .prepare('SELECT version, content, created_at FROM mm_artifact_versions WHERE artifact_id = ? AND version = ?')
      .get(id, row.current_version) as VersionRow | undefined;
    if (!version) throw new Error(`ArtifactStore.get: missing version row for ${id}`);
    return {
      id: row.id,
      title: row.title,
      version: version.version,
      content: version.content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): Artifact[] {
    const rows = this.mdb.db
      .prepare('SELECT id FROM mm_artifacts ORDER BY updated_at DESC')
      .all() as unknown as unknown as { id: string }[];
    return rows.map((r) => this.get(r.id));
  }

  /** Save new content as the next immutable version. */
  update(id: string, content: string): Artifact {
    const current = this.get(id);
    const next = requireContent(content);
    const version = current.version + 1;
    const now = Date.now();
    this.mdb.db
      .prepare('UPDATE mm_artifacts SET current_version = ?, updated_at = ? WHERE id = ?')
      .run(version, now, id);
    this.mdb.db
      .prepare(
        'INSERT INTO mm_artifact_versions (id, artifact_id, version, content, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), id, version, next, now);
    return this.get(id);
  }

  /** All versions, oldest first. */
  versions(id: string): ArtifactVersion[] {
    this.get(id); // throws NotFoundError for unknown artifacts
    const rows = this.mdb.db
      .prepare(
        'SELECT version, content, created_at FROM mm_artifact_versions WHERE artifact_id = ? ORDER BY version ASC',
      )
      .all(id) as unknown as unknown as VersionRow[];
    return rows.map((r) => ({ version: r.version, content: r.content, createdAt: r.created_at }));
  }

  /**
   * FL-8: delete an artifact and ALL of its versions atomically (single
   * transaction — content never survives its artifact row or vice versa).
   * Public shares / mini-app data for page-backed artifacts live in the
   * API layer's pages.db and are removed by AtomicArtifactDeleter in the
   * same operation from the caller's perspective.
   */
  remove(id: string): void {
    this.get(id); // throws NotFoundError for unknown artifacts
    this.mdb.db.exec('BEGIN IMMEDIATE');
    try {
      this.mdb.db.prepare('DELETE FROM mm_artifact_versions WHERE artifact_id = ?').run(id);
      this.mdb.db.prepare('DELETE FROM mm_artifacts WHERE id = ?').run(id);
      this.mdb.db.exec('COMMIT');
    } catch (err) {
      try {
        this.mdb.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }
  }

  getVersion(id: string, version: number): ArtifactVersion {
    this.get(id);
    const row = this.mdb.db
      .prepare('SELECT version, content, created_at FROM mm_artifact_versions WHERE artifact_id = ? AND version = ?')
      .get(id, version) as VersionRow | undefined;
    if (!row) throw new NotFoundError(`unknown version ${version} for artifact ${id}`);
    return { version: row.version, content: row.content, createdAt: row.created_at };
  }
}

function requireContent(content: unknown): string {
  if (typeof content !== 'string' || !content.trim()) {
    throw new ValidationError('artifact "content" must be a non-empty markdown string');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new ValidationError('artifact "content" exceeds the 1 MiB version limit');
  }
  return content;
}
