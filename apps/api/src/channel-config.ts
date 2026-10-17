// SPDX-License-Identifier: Apache-2.0
// Per-channel richness (OpenMausBot parity): every messaging channel
// (telegram, discord, slack, whatsapp, webhook) gets shared instructions,
// a working folder, and responder rules, editable in one surface.
//
//   GET /api/messaging/channels        → [{ id, name, config }]
//   PUT /api/messaging/channels/:id   { instructions?, workingFolder?, responderRules? }
//
// The channel's instructions are injected into the bot's context for turns
// triggered from that channel (via RunTurnOptions.memoryContext in the
// onMention wiring in routes.ts); the working folder scopes file tools for
// those turns (via the spaceWorkspaceOverride-compatible path — the host
// passes it as the turn's workspace override).

import express, { type Router } from 'express';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listMessageProviders } from './messaging.js';

export interface ChannelConfig {
  /** Extra system-prompt section for turns from this channel. */
  instructions: string;
  /** Working folder for file tools during channel turns. */
  workingFolder: string;
  /** When/how the bot responds (e.g. "reply only on direct mention"). */
  responderRules: string;
}

const CHANNEL_CONFIG_FILE = 'channel-config.json';
const MAX_FIELD = 8000;

const DEFAULTS: ChannelConfig = { instructions: '', workingFolder: '', responderRules: '' };

function configPath(dataDir: string): string {
  return join(dataDir, CHANNEL_CONFIG_FILE);
}

type ChannelConfigFile = Record<string, Partial<ChannelConfig>>;

function readFile(dataDir: string): ChannelConfigFile {
  try {
    const parsed = JSON.parse(readFileSync(configPath(dataDir), 'utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as ChannelConfigFile;
    }
  } catch {
    // absent or corrupt → empty
  }
  return {};
}

function writeFile(dataDir: string, file: ChannelConfigFile): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${configPath(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  const { renameSync } = require('node:fs') as typeof import('node:fs');
  renameSync(tmp, configPath(dataDir));
}

/** All known channel ids: registered message providers + the generic webhook ingress. */
export function listChannelIds(): string[] {
  const ids = new Set<string>([...listMessageProviders(), 'webhook']);
  return [...ids].sort();
}

export function getChannelConfig(dataDir: string, channelId: string): ChannelConfig {
  const raw = readFile(dataDir)[channelId] ?? {};
  return {
    instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
    workingFolder: typeof raw.workingFolder === 'string' ? raw.workingFolder : '',
    responderRules: typeof raw.responderRules === 'string' ? raw.responderRules : '',
  };
}

export function setChannelConfig(dataDir: string, channelId: string, patch: Partial<ChannelConfig>): ChannelConfig {
  const current = getChannelConfig(dataDir, channelId);
  const next: ChannelConfig = { ...current };
  for (const key of ['instructions', 'workingFolder', 'responderRules'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
    if (v.length > MAX_FIELD) throw new Error(`"${key}" is limited to ${MAX_FIELD} characters`);
    next[key] = v;
  }
  const file = readFile(dataDir);
  file[channelId] = next;
  writeFile(dataDir, file);
  return next;
}

/**
 * Render a channel's config as a memory-context section for the turn.
 * Empty string when the channel has no instructions/rules configured.
 */
export function channelContextSection(dataDir: string, channelId: string): string {
  const cfg = getChannelConfig(dataDir, channelId);
  const parts: string[] = [];
  if (cfg.instructions.trim()) {
    parts.push(`# Channel instructions (${channelId})`, '', cfg.instructions.trim());
  }
  if (cfg.responderRules.trim()) {
    parts.push('', `# Responder rules (${channelId})`, '', cfg.responderRules.trim());
  }
  return parts.join('\n').trim();
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export interface ChannelConfigRouterDeps {
  dataDir: string;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

export function createChannelConfigRouter(deps: ChannelConfigRouterDeps): Router {
  const router = express.Router();

  router.get('/channels', (_req, res) => {
    try {
      res.json({
        ok: true,
        channels: listChannelIds().map((id) => ({ id, config: getChannelConfig(deps.dataDir, id) })),
      });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list channels', err instanceof Error ? err.message : String(err)));
    }
  });

  router.put('/channels/:id', (req, res) => {
    const id = req.params.id;
    if (!listChannelIds().includes(id)) {
      res.status(404).json(errorBody(`Unknown channel "${id}"`, `Known: ${listChannelIds().join(', ')}`));
      return;
    }
    const body = (req.body ?? {}) as Partial<ChannelConfig>;
    try {
      const config = setChannelConfig(deps.dataDir, id, body);
      deps.audit('channel.config_updated', { actor: 'api', detail: { channel: id } });
      res.json({ ok: true, id, config });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to save channel config'));
    }
  });

  router.get('/channels/:id', (req, res) => {
    const id = req.params.id;
    if (!listChannelIds().includes(id)) {
      res.status(404).json(errorBody(`Unknown channel "${id}"`, `Known: ${listChannelIds().join(', ')}`));
      return;
    }
    try {
      res.json({ ok: true, id, config: getChannelConfig(deps.dataDir, id) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to read channel config', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}
