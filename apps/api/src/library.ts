// SPDX-License-Identifier: Apache-2.0
// Single Library surface (Muse parity §4.5 C-15, §4.8 FL-11/FL-14).
//
// C-15: ONE Library that unifies the three stores that already exist —
// muse-module artifacts, slide decks, generated media and workspace
// files — behind a single item shape and a single search. This module
// holds NO content of its own: every item is a route/view over the
// owning store, so there is never a second copy to drift.
//
// FL-11: a System Files view inside the same surface: a read-only,
// metadata-only listing of the instance's own data directory (DBs,
// uploads, config stores) so the user can see what KriyaDot keeps
// without shell access. Contents are never served from this view.
//
// FL-14: editability is a property of the item: markdown artifacts and
// decks are `editable: true` (the routes layer saves through the owning
// store, which versions artifacts / validates decks); media and files
// are view/download only.

import fs from 'node:fs';
import path from 'node:path';

export type LibraryKind = 'artifact' | 'deck' | 'media' | 'file';

export interface LibraryItem {
  /** `<kind>:<owning-store id>` — stable across surfaces. */
  id: string;
  kind: LibraryKind;
  title: string;
  /** Owning-store id (artifact id, deck id, media id, workspace-relative path). */
  ref: string;
  mimeType?: string;
  sizeBytes?: number;
  updatedAt: string; // ISO
  /** FL-14: true for markdown artifacts and decks. */
  editable: boolean;
  /** Short preview line for list rendering. */
  preview?: string;
}

export interface ArtifactLike {
  id: string;
  title: string;
  version: number;
  content: string;
  updatedAt: number;
}
export interface DeckLike {
  id: string;
  title: string;
  slides: unknown[];
  updatedAt: number;
}
export interface MediaLike {
  id: string;
  kind: string;
  prompt: string;
  url: string;
  mimeType: string;
  byteLength: number;
  provider: string;
}
export interface FileLike {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FileLike[];
}

export interface LibrarySources {
  artifacts: () => ArtifactLike[];
  decks: () => DeckLike[];
  /** Generated media assets known to this process (may be empty). */
  media: () => MediaLike[];
  /** Flattened workspace file listing (files only, dirs excluded). */
  files: () => FileLike[];
  /** Epoch-ms → ISO helper injection point for tests. */
  nowIso?: () => string;
}

function previewOf(content: string): string {
  const line = content.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return (line ?? content.trim()).slice(0, 140);
}

function flattenFiles(nodes: FileLike[], out: FileLike[] = []): FileLike[] {
  for (const n of nodes) {
    if (n.type === 'file') out.push(n);
    if (n.children) flattenFiles(n.children, out);
  }
  return out;
}

export function mimeForPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav', '.pdf': 'application/pdf', '.html': 'text/html',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Build the unified, most-recently-updated-first Library listing (C-15). */
export function buildLibraryItems(sources: LibrarySources): LibraryItem[] {
  const items: LibraryItem[] = [];
  for (const a of sources.artifacts()) {
    items.push({
      id: `artifact:${a.id}`, kind: 'artifact', title: a.title, ref: a.id,
      mimeType: 'text/markdown', updatedAt: new Date(a.updatedAt).toISOString(),
      editable: true, preview: previewOf(a.content),
    });
  }
  for (const d of sources.decks()) {
    items.push({
      id: `deck:${d.id}`, kind: 'deck', title: d.title, ref: d.id,
      mimeType: 'application/vnd.kriyadot.deck+json', updatedAt: new Date(d.updatedAt).toISOString(),
      editable: true, preview: `${d.slides.length} slide${d.slides.length === 1 ? '' : 's'}`,
    });
  }
  for (const m of sources.media()) {
    items.push({
      id: `media:${m.id}`, kind: 'media', title: m.prompt.slice(0, 120), ref: m.id,
      mimeType: m.mimeType, sizeBytes: m.byteLength || undefined,
      updatedAt: new Date(0).toISOString(), editable: false, preview: `${m.kind} · ${m.provider} · ${m.url}`,
    });
  }
  for (const f of flattenFiles(sources.files())) {
    items.push({
      id: `file:${f.path}`, kind: 'file', title: f.name, ref: f.path,
      mimeType: mimeForPath(f.path), sizeBytes: f.size,
      updatedAt: new Date(0).toISOString(), editable: false,
    });
  }
  items.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  // Artifacts/decks carry real timestamps: newest first within the full list
  // is the primary sort; title breaks ties deterministically.
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
  return items;
}

/** Case-insensitive title/preview search + optional kind filter. */
export function filterLibraryItems(items: LibraryItem[], q?: string, kind?: string): LibraryItem[] {
  let out = items;
  if (kind && kind !== 'all') out = out.filter((i) => i.kind === kind);
  const needle = (q ?? '').trim().toLowerCase();
  if (needle) {
    out = out.filter((i) => i.title.toLowerCase().includes(needle) || (i.preview ?? '').toLowerCase().includes(needle) || i.ref.toLowerCase().includes(needle));
  }
  return out;
}

// ---- FL-11: System Files ----------------------------------------------------

export interface SystemFileEntry {
  name: string;
  /** Category the UI groups by: database | upload | store | other. */
  category: 'database' | 'upload' | 'store' | 'other';
  sizeBytes: number;
  modifiedAt: string; // ISO
}

export function categorizeSystemFile(name: string): SystemFileEntry['category'] {
  if (name.endsWith('.db') || name.endsWith('.db-wal') || name.endsWith('.db-shm')) return 'database';
  if (name.endsWith('.json')) return 'store';
  return 'other';
}

/**
 * Metadata-only listing of the instance data directory (FL-11).
 * One level deep plus the uploads folder count; never reads contents,
 * never follows symlinks, never throws on a missing dir.
 */
export function listSystemFiles(dataDir: string): SystemFileEntry[] {
  const out: SystemFileEntry[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const abs = path.join(dataDir, e.name);
    try {
      const st = fs.statSync(abs);
      if (e.isDirectory()) {
        if (e.name === 'uploads') {
          const count = fs.readdirSync(abs).filter((f) => !f.endsWith('.meta.json')).length;
          out.push({ name: 'uploads/', category: 'upload', sizeBytes: 0, modifiedAt: st.mtime.toISOString(), previewCount: count } as SystemFileEntry & { previewCount: number });
        }
        continue;
      }
      out.push({ name: e.name, category: categorizeSystemFile(e.name), sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
    } catch { /* raced removal — skip */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
