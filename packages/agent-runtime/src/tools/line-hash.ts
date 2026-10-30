// SPDX-License-Identifier: Apache-2.0
/**
 * Stable per-line content hashes (#184 edit-mode depth).
 *
 * `read_file` (with hashed lines on) renders each line as
 * `<lineNo>#<hash>: <content>`; the `edit` tool's range mode then
 * requires the caller to quote the hashes of the boundary lines it
 * intends to replace. If the file changed since the read, the hashes
 * no longer match and the edit fails with a stale-file error instead
 * of silently editing the wrong lines.
 *
 * The hash is a truncated SHA-256 of the exact line content (no line
 * terminator, no line number), so it is stable across reads, machines,
 * and trailing-newline differences at end of file.
 */
import { createHash } from 'node:crypto';

/** Truncated SHA-256 (6 hex chars) of one line's exact content. */
export function lineHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 6);
}

/** Render file content with hashed line identifiers: `123#a3f9c2: content`. */
export function formatHashedLines(content: string): string {
  return content
    .split('\n')
    .map((line, i) => `${i + 1}#${lineHash(line)}: ${line}`)
    .join('\n');
}
