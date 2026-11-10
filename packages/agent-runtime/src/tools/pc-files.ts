// SPDX-License-Identifier: Apache-2.0
// PC file tools: directory listing across the workspace and user-granted
// PC folders, plus the shared resolver that lets read_file (builtin.ts)
// reach granted folders.
//
// Access model (pc-access.ts): paths inside the workspace behave exactly
// as before. Absolute paths outside it are canonicalized (realpath —
// symlink escapes resolve to their true target) and must sit inside a
// folder the user granted this bot (Settings → Permissions → PC file
// access), a folder allowed once earlier in this session, or a folder
// the user approves on the just-in-time request card the tool raises.
// v1 is read-only: nothing here writes outside the workspace.

import { readdirSync, statSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { ToolContext, ToolDefinition } from '../types.js';
import { resolveWorkspaceDir, type WorkspaceSource } from '../workspaces.js';
import { confineRealpath } from '../confine.js';
import {
  canonicalizeAbsolutePath,
  ensurePcFolderAccess,
  isPathInsideRoot,
} from '../pc-access.js';

const MAX_LIST_ENTRIES = 500;

export interface FolderEntry {
  name: string;
  type: 'folder' | 'file' | 'other';
  size?: number;
}

function listEntries(absDir: string): { entries: FolderEntry[]; total: number; truncated: boolean } {
  const names = readdirSync(absDir);
  const entries: FolderEntry[] = [];
  for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
    let st: Stats | undefined;
    try {
      st = statSync(join(absDir, name));
    } catch {
      st = undefined; // broken symlink / racing delete — list as 'other'
    }
    if (st?.isDirectory()) entries.push({ name, type: 'folder' });
    else if (st?.isFile()) entries.push({ name, type: 'file', size: st.size });
    else entries.push({ name, type: 'other' });
  }
  entries.sort(
    (a, b) =>
      (a.type === 'folder' ? 0 : 1) - (b.type === 'folder' ? 0 : 1) ||
      a.name.localeCompare(b.name),
  );
  return { entries, total: names.length, truncated: names.length > MAX_LIST_ENTRIES };
}

/**
 * Resolve a read_file target that escaped the workspace: grant-check its
 * canonical (real) location and return the canonical path when access is
 * granted/approved. Throws the original confinement error for relative
 * paths, and a plain refusal when the user denies the request card.
 */
export async function resolvePcReadableFile(
  ctx: ToolContext,
  raw: string,
  originalError: unknown,
): Promise<string> {
  if (!isAbsolute(raw)) throw originalError;
  // No PC-access host (CLI / headless / SDK): preserve the original
  // workspace-fence behaviour exactly — PC access simply doesn't exist.
  if (!ctx.pcAccess) throw originalError;
  const canonical = canonicalizeAbsolutePath(raw);
  const folder = dirname(canonical);
  const access = await ensurePcFolderAccess(ctx, folder, 'read', canonical);
  if (!access.ok) throw new Error(access.reason);
  // The authorization covered `folder` (the file's real directory) or a
  // granted root above it; the file itself must sit inside one of those.
  if (
    !isPathInsideRoot(folder, canonical) &&
    !(access.root && isPathInsideRoot(access.root, canonical))
  ) {
    throw new Error(`Path escapes granted folders: "${raw}"`);
  }
  return canonical;
}

export function listFolderTool(workspaceDir: WorkspaceSource): ToolDefinition {
  return {
    name: 'list_folder',
    description:
      'List the contents of a folder (names, types, file sizes). Works for folders inside ' +
      'the workspace (relative or absolute path) and for PC folders outside it that the user ' +
      'has granted this bot access to (e.g. their Desktop or Documents, granted in Settings → ' +
      'Permissions → PC file access). For an ungranted PC folder, the user is shown an approval ' +
      'card (allow once / always allow / deny) and the call waits for their choice. Read-only: ' +
      'this tool never changes anything. Use read_file to read a file you find here.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Folder to list: workspace-relative (e.g. "notes") or an absolute PC path ' +
            '(e.g. "C:\\\\Users\\\\me\\\\Desktop" or "/home/me/Desktop")',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const raw = String(args.path ?? '').trim();
      if (!raw) throw new Error('list_folder: "path" is required');
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      let wsAbs: string | null = null;
      try {
        wsAbs = confineRealpath(ws, raw);
      } catch {
        wsAbs = null; // escapes the workspace — maybe a granted PC folder
      }
      if (wsAbs !== null) {
        const st = statSync(wsAbs);
        if (!st.isDirectory()) throw new Error(`list_folder: not a folder: "${raw}"`);
        return { path: wsAbs, scope: 'workspace', ...listEntries(wsAbs) };
      }
      if (!isAbsolute(raw)) throw new Error(`Path escapes workspace: "${raw}"`);
      const canonical = canonicalizeAbsolutePath(raw);
      const access = await ensurePcFolderAccess(ctx, canonical, 'list');
      if (!access.ok) throw new Error(access.reason);
      const st = statSync(canonical);
      if (!st.isDirectory()) throw new Error(`list_folder: not a folder: "${raw}"`);
      return { path: canonical, scope: 'pc', accessVia: access.via, ...listEntries(canonical) };
    },
  };
}
