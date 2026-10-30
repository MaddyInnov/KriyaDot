// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { canEditInViewer, filterItems, formatBytes, isViewableMedia, type LibraryItem } from './library';

const items: LibraryItem[] = [
  { id: 'artifact:1', kind: 'artifact', title: 'Launch plan', ref: '1', mimeType: 'text/markdown', updatedAt: '2026-10-30T00:00:00Z', editable: true },
  { id: 'deck:2', kind: 'deck', title: 'Pitch', ref: '2', updatedAt: '2026-10-29T00:00:00Z', editable: true },
  { id: 'media:3', kind: 'media', title: 'a cat', ref: '3', mimeType: 'image/png', updatedAt: '2026-10-28T00:00:00Z', editable: false },
  { id: 'file:4', kind: 'file', title: 'notes.md', ref: 'notes.md', mimeType: 'text/markdown', updatedAt: '2026-10-27T00:00:00Z', editable: false },
];

describe('library helpers (C-15/FL-14/C-10)', () => {
  it('FL-14: only artifacts and decks are editable in the viewer', () => {
    expect(canEditInViewer(items[0]!)).toBe(true);
    expect(canEditInViewer(items[1]!)).toBe(true);
    expect(canEditInViewer(items[2]!)).toBe(false);
    expect(canEditInViewer(items[3]!)).toBe(false);
  });
  it('C-10: media items and image/video/audio files are viewable', () => {
    expect(isViewableMedia(items[2]!)).toBe(true);
    expect(isViewableMedia({ kind: 'file', mimeType: 'video/mp4' })).toBe(true);
    expect(isViewableMedia(items[0]!)).toBe(false);
  });
  it('filters by tab and query', () => {
    expect(filterItems(items, 'deck', '')).toHaveLength(1);
    expect(filterItems(items, 'all', 'launch')).toHaveLength(1);
    expect(filterItems(items, 'all', '')).toHaveLength(4);
  });
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(undefined)).toBe('—');
  });
});
