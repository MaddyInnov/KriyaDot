// SPDX-License-Identifier: Apache-2.0
// Auto-allocated per-bot workspaces (Codync parity).
//
// Every bot gets its own workspace directory at
// `<dataDir>/bots/<botId>/workspace`, created automatically when the bot is
// created (seed load, import, or API creation). This gives each bot an
// isolated working directory without requiring project selection at creation
// time — matching Codync's `~/.codync/bots/<id>/workspace` behavior, but
// rooted at the platform-appropriate data dir instead of a hardcoded home.
//
// The workspace is stored on the bot config as an absolute path inside
// dataDir (valid per validateBotWorkspace). Callers that serialize bots for
// API responses should include `workspacePath` (the resolved absolute path)
// via `botWorkspacePath()`.

import fs from 'node:fs';
import path from 'node:path';
import type { BotConfig } from '@mvp/agent-runtime';

/** Validate a bot id for use as a path segment (same rules as roster import). */
function validBotId(id: string): boolean {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * Ensure the auto-allocated workspace directory exists for a bot and return
 * its absolute path. Creates `<dataDir>/bots/<botId>/workspace` recursively.
 * Throws on invalid bot id.
 */
export function ensureBotWorkspaceDir(botId: string, dataDir: string): string {
  if (!validBotId(botId)) {
    throw new Error(`invalid bot id for workspace allocation: ${botId}`);
  }
  const dir = path.resolve(dataDir, 'bots', botId, 'workspace');
  // Safety: the resolved path must stay inside dataDir.
  const dataRoot = path.resolve(dataDir);
  if (dir !== dataRoot && !dir.startsWith(dataRoot + path.sep)) {
    throw new Error('bot workspace escapes the data directory');
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Allocate a workspace for a bot: creates the directory and sets
 * `bot.workspace` to the absolute path (inside dataDir, valid per
 * validateBotWorkspace). Idempotent — safe to call for bots that already
 * have a workspace configured (leaves explicit config untouched).
 *
 * Returns the workspace path, or null if the bot already has an explicit
 * workspace configured (we don't override user choice).
 */
export function allocateBotWorkspace(bot: BotConfig, dataDir: string): string | null {
  if (bot.workspace && bot.workspace.trim()) {
    // Bot already has an explicit workspace — don't override.
    return null;
  }
  const dir = ensureBotWorkspaceDir(bot.id, dataDir);
  bot.workspace = dir;
  return dir;
}

/**
 * Allocate workspaces for a list of bots (seed load, import apply). Returns
 * the bot ids that got new workspaces.
 */
export function allocateBotWorkspaces(bots: BotConfig[], dataDir: string): string[] {
  const allocated: string[] = [];
  for (const bot of bots) {
    try {
      const dir = allocateBotWorkspace(bot, dataDir);
      if (dir) allocated.push(bot.id);
    } catch (err) {
      // Invalid bot id — log and continue; the bot still works with the
      // global workspace.
      console.warn(`[bot-workspace-alloc] skipping ${bot.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return allocated;
}

/**
 * Resolve the workspace path to include in API responses. Returns the
 * bot's configured workspace if set, otherwise the auto-allocated default
 * path (created on demand).
 */
export function botWorkspacePath(bot: BotConfig, dataDir: string): string {
  if (bot.workspace && bot.workspace.trim()) {
    return path.resolve(bot.workspace);
  }
  return ensureBotWorkspaceDir(bot.id, dataDir);
}
