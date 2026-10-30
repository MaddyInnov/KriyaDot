// SPDX-License-Identifier: Apache-2.0
// Library surface helpers (Muse parity §4.5 C-15 / FL-11 / FL-14).
// Pure logic for the unified Library page under Workspace: item shape
// mirrors apps/api library-routes.ts exactly.

export type LibraryKind = 'artifact' | 'deck' | 'media' | 'file';

export interface LibraryItem {
  id: string;
  kind: LibraryKind;
  title: string;
  ref: string;
  mimeType?: string;
  sizeBytes?: number;
  updatedAt: string;
  editable: boolean;
  preview?: string;
}

export interface SystemFileEntry {
  name: string;
  category: 'database' | 'upload' | 'store' | 'other';
  sizeBytes: number;
  modifiedAt: string;
}

export const LIBRARY_TABS: Array<{ id: LibraryKind | 'all' | 'system'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'artifact', label: 'Artifacts' },
  { id: 'deck', label: 'Decks' },
  { id: 'media', label: 'Media' },
  { id: 'file', label: 'Files' },
  { id: 'system', label: 'System Files' },
];

export function kindLabel(kind: LibraryKind): string {
  return { artifact: 'Artifact', deck: 'Deck', media: 'Media', file: 'File' }[kind];
}

/** C-10: is this library item openable in the in-chat media viewer? */
export function isViewableMedia(item: Pick<LibraryItem, 'kind' | 'mimeType'>): boolean {
  if (item.kind === 'media') return true;
  const mt = item.mimeType ?? '';
  return mt.startsWith('image/') || mt.startsWith('video/') || mt.startsWith('audio/');
}

export function formatBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** FL-14: the viewer offers editing exactly when the item says editable. */
export function canEditInViewer(item: Pick<LibraryItem, 'editable' | 'kind'>): boolean {
  return item.editable && (item.kind === 'artifact' || item.kind === 'deck');
}

export function filterItems(items: LibraryItem[], tab: string, q: string): LibraryItem[] {
  let out = items;
  if (tab !== 'all' && tab !== 'system') out = out.filter((i) => i.kind === tab);
  const needle = q.trim().toLowerCase();
  if (needle) out = out.filter((i) => i.title.toLowerCase().includes(needle) || (i.preview ?? '').toLowerCase().includes(needle));
  return out;
}
