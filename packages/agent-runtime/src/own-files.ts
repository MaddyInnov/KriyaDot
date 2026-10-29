// SPDX-License-Identifier: Apache-2.0
// Own-files reads never need approval (W8e).
//
// A bot reading files inside its OWN workspace/memory area is the most
// routine operation there is — prompting for it trains users to approve
// blindly. So: read-only file operations whose resolved (realpath-
// confined) target lies within one of the bot's own areas are auto-
// allowed by the runtime BEFORE any governance policy / approval-level
// evaluation.
//
// Boundaries (deliberate):
// - Only a fixed whitelist of read-only file tools qualifies. Writes,
//   edits, commands and everything else are governed exactly as before.
// - The target must survive confineRealpath() against an own area —
//   symlink escapes and `..` traversal fail closed (governed normally).
// - This never weakens confinement (the tools still confine at execute
//   time) and never touches the catastrophic-command floor (read tools
//   cannot run commands).

import { confineRealpath } from './confine.js';
import type { ToolCall } from './types.js';

/** Read-only file tools eligible for the own-files auto-allow. */
export const OWN_FILE_READ_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'glob',
  'grep',
  'lsp_definition',
  'lsp_hover',
]);

/** Tools in the whitelist whose call carries an explicit file/dir path arg. */
const PATH_ARG_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'grep',
  'lsp_definition',
  'lsp_hover',
]);

function isWithinOwnArea(ownDirs: readonly string[], target: string): boolean {
  for (const dir of ownDirs) {
    if (!dir) continue;
    try {
      // Throws when the real path escapes this area — and also when the
      // area itself does not exist (realpath of the root fails), which
      // fails closed: a vanished workspace is governed normally.
      confineRealpath(dir, target);
      return true;
    } catch {
      // Not within this area — try the next one.
    }
  }
  return false;
}

/**
 * True when `call` is a read-only file operation fully inside one of
 * `ownDirs` (the bot's own workspace/memory areas, absolute paths).
 *
 * - read_file / lsp_*: the `path` arg must resolve inside an own area.
 * - grep: `path` arg when present must be inside; absent → the tool
 *   searches from the workspace root, which is the own area by
 *   construction (the tool confines itself at execute time).
 * - glob: patterns are matched against workspace-relative paths by the
 *   tool itself (it walks only the workspace), and a pattern containing
 *   a `..` segment is rejected here so it can never be auto-allowed.
 */
export function isOwnWorkspaceRead(call: ToolCall, ownDirs: readonly string[]): boolean {
  if (!ownDirs || ownDirs.length === 0) return false;
  if (!OWN_FILE_READ_TOOLS.has(call.name)) return false;
  const args = call.args ?? {};
  if (call.name === 'glob') {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    if (!pattern) return false;
    if (pattern.split('/').includes('..')) return false;
    return true;
  }
  if (PATH_ARG_TOOLS.has(call.name)) {
    const rawPath = args.path;
    if (rawPath === undefined || rawPath === null || rawPath === '') {
      // grep without a path searches the workspace root (own area).
      return call.name === 'grep';
    }
    if (typeof rawPath !== 'string') return false;
    return isWithinOwnArea(ownDirs, rawPath);
  }
  return false;
}
