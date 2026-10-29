// SPDX-License-Identifier: Apache-2.0
/**
 * Project instruction files (Octomind parity).
 *
 * Coding-agent table stakes: a workspace can carry standing instructions
 * for any agent working in it. At turn start the runtime looks for, in
 * priority order:
 *
 *   1. AGENTS.md          — the cross-tool standard file
 *   2. KRIYADOT.md        — KriyaDot-specific instructions
 *   3. .kriyadot/instructions.md
 *
 * Every file found is included (in that order), each under its own
 * heading so the model can see where an instruction came from. Content
 * is capped (per-file and total) so a pathological file cannot crowd
 * out the context. Results are cached per directory and invalidated by
 * mtime/size, the same discipline as the skill summary cache.
 *
 * Trust treatment matches skills: these are local, human-authored files
 * inside the bot's own workspace; they enter the system prompt as
 * project instructions (the untrusted-content floor still applies to
 * tool output and peer content).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_INSTRUCTION_CANDIDATES = [
  'AGENTS.md',
  'KRIYADOT.md',
  '.kriyadot/instructions.md',
] as const;

const MAX_PER_FILE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 16_000;

export interface ProjectInstructions {
  /** Rendered prompt section (headings + file contents), ready to append. */
  text: string;
  /** Workspace-relative paths of the files that were loaded. */
  files: string[];
}

interface CacheEntry {
  signature: string;
  result: ProjectInstructions | undefined;
}

const cache = new Map<string, CacheEntry>();

function signatureFor(dir: string): string {
  const parts: string[] = [];
  for (const rel of PROJECT_INSTRUCTION_CANDIDATES) {
    const file = join(dir, rel);
    try {
      const s = statSync(file);
      parts.push(`${rel}:${s.mtimeMs}:${s.size}`);
    } catch {
      parts.push(`${rel}:-`);
    }
  }
  return parts.join('|');
}

/**
 * Load project instructions for a workspace directory. Returns undefined
 * when no instruction file exists. Never throws — a broken file must not
 * break a turn.
 */
export function loadProjectInstructions(dir: string): ProjectInstructions | undefined {
  if (!dir) return undefined;
  let signature: string;
  try {
    signature = signatureFor(dir);
  } catch {
    return undefined;
  }
  const cached = cache.get(dir);
  if (cached && cached.signature === signature) return cached.result;

  const sections: string[] = [];
  const files: string[] = [];
  let total = 0;
  for (const rel of PROJECT_INSTRUCTION_CANDIDATES) {
    const file = join(dir, rel);
    if (!existsSync(file)) continue;
    let content: string;
    try {
      content = readFileSync(file, 'utf8').trim();
    } catch {
      continue;
    }
    if (!content) continue;
    let body = content.slice(0, MAX_PER_FILE_CHARS);
    if (content.length > MAX_PER_FILE_CHARS) body += '\n…[truncated]';
    if (total + body.length > MAX_TOTAL_CHARS) {
      body = body.slice(0, Math.max(0, MAX_TOTAL_CHARS - total));
      if (!body) break;
    }
    total += body.length;
    files.push(rel);
    sections.push(`## Project instructions — ${rel}\n${body}`);
  }
  const result =
    sections.length > 0 ? { text: sections.join('\n\n'), files } : undefined;
  cache.set(dir, { signature, result });
  return result;
}

/** Test hook: drop the cache (files changed underneath us). */
export function clearProjectInstructionsCache(): void {
  cache.clear();
}
