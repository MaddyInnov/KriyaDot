// SPDX-License-Identifier: Apache-2.0
// CA-34: folder-session client helpers — build the shareable unit the
// API validates in apps/api/src/folder-session.ts (same shape, mirrored
// here as a pure builder so the Workspace panel stays thin and testable).

export interface FolderSessionDraft {
  id: string;
  name: string;
  folder: string;
  botId: string;
  systemPrompt: string;
  placement: 'local' | 'cloud-report' | 'cloud-only';
}

export function buildFolderSessionJson(draft: FolderSessionDraft): Record<string, unknown> {
  return {
    kind: 'folder-session',
    version: 1,
    id: draft.id.trim(),
    name: draft.name.trim(),
    description: `Folder session for ${draft.folder}`,
    folder: draft.folder.trim(),
    bot: { id: draft.botId.trim(), name: draft.botId.trim(), systemPrompt: draft.systemPrompt, tools: [], skills: [] },
    routines: [],
    placement: draft.placement,
    entryIds: [draft.botId.trim()],
  };
}

export function isSafeFolderPath(folder: string): boolean {
  if (!folder || folder.startsWith('/') || folder.includes('\\')) return false;
  return folder.split('/').every((seg) => seg !== '..' && seg.length > 0);
}
