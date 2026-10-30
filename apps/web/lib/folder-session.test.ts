// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { buildFolderSessionJson, isSafeFolderPath } from './folder-session';

describe('CA-34 folder-session builder', () => {
  it('builds the API-shaped unit', () => {
    const j = buildFolderSessionJson({ id: 'proj', name: 'Proj', folder: 'projects/proj', botId: 'coder', systemPrompt: 'Code.', placement: 'local' });
    expect(j.kind).toBe('folder-session');
    expect((j.bot as { id: string }).id).toBe('coder');
    expect(j.entryIds).toEqual(['coder']);
  });
  it('flags unsafe folders', () => {
    expect(isSafeFolderPath('projects/proj')).toBe(true);
    expect(isSafeFolderPath('../escape')).toBe(false);
    expect(isSafeFolderPath('/abs')).toBe(false);
  });
});
