// SPDX-License-Identifier: Apache-2.0
//
// Symlink-aware workspace confinement.
//
// A purely lexical prefix check (`resolve(root, p).startsWith(root)`) is not
// enough: `sub/link` can be a symlink pointing at `/etc`, and the lexical
// check passes while the real file opened is outside the workspace. This
// helper resolves the REAL path — via the nearest existing ancestor, so it
// also works for paths that don't exist yet (a file about to be written) —
// and re-checks the workspace prefix against the real path.
//
// NOTE: this closes the confinement hole but is not a TOCTOU-proof sandbox:
// a symlink swapped between this check and the file open could still race.
// Callers that need hard guarantees should open with O_NOFOLLOW or run
// inside the Docker/E2B sandbox.

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

/**
 * Resolve `p` inside `workspaceDir`, following symlinks. Throws if the real
 * path escapes the workspace (directory traversal or symlink escape).
 * Symlinks that stay inside the workspace are allowed.
 */
export function confineRealpath(workspaceDir: string, p: string): string {
  const root = resolve(workspaceDir);
  const resolved = resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Path escapes workspace: "${p}"`);
  }
  // The target itself may not exist yet (write_file creates it): walk up to
  // the nearest existing ancestor, realpath that, then re-append the rest.
  let ancestor = resolved;
  const rest: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break; // filesystem root — cannot happen here
    rest.unshift(basename(ancestor));
    ancestor = parent;
  }
  let real = realpathSync(ancestor);
  for (const seg of rest) real = resolve(real, seg);
  // Compare against the real workspace root too: the root itself may live
  // under a symlinked prefix (e.g. /tmp on macOS → /private/tmp).
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error(`Path escapes workspace via symlink: "${p}"`);
  }
  return real;
}
