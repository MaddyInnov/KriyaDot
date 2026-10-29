// SPDX-License-Identifier: Apache-2.0
// Per-bot MBTI persona persistence.
//
// Bot configs ship in seed/bots.json (immutable at runtime, and embedded in
// the single-file binary). Persona selections from the UI are overlaid in
// <dataDir>/bot-personas.json: { "<botId>": "<MBTI>" }. Applied onto the
// in-memory bots at boot (HOST WIRING: call applyBotPersonas(seed.bots,
// config.dataDir) in index.ts) and updated by PUT /api/bots/:id/persona.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePersona, type MbtiType } from '@mvp/agent-runtime';
import type { BotConfig } from '@mvp/agent-runtime';

const PERSONAS_FILE = 'bot-personas.json';

export function botPersonasPath(dataDir: string): string {
  return path.join(dataDir, PERSONAS_FILE);
}

type PersonaFile = Record<string, string>;

function readFile(dataDir: string): PersonaFile {
  try {
    const raw = fs.readFileSync(botPersonasPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as PersonaFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function writeFile(dataDir: string, file: PersonaFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = botPersonasPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, botPersonasPath(dataDir));
}

/** Apply persisted personas onto the in-memory bots. Call at boot. */
export function applyBotPersonas(bots: BotConfig[], dataDir: string): void {
  const file = readFile(dataDir);
  const byId = new Map(bots.map((b) => [b.id, b]));
  for (const [botId, persona] of Object.entries(file)) {
    const bot = byId.get(botId);
    if (!bot) continue;
    if (resolvePersona(persona)) bot.persona = (persona as string).trim().toUpperCase() as MbtiType;
  }
}

/** Validate + persist a bot's persona. Returns the normalized persona (or null). Throws on problems. */
export function saveBotPersona(dataDir: string, bots: BotConfig[], botId: string, persona: unknown): MbtiType | null {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot "${botId}"`);
  if (persona === null || persona === undefined || (typeof persona === 'string' && !persona.trim())) {
    const file = readFile(dataDir);
    delete file[botId];
    writeFile(dataDir, file);
    bot.persona = null;
    return null;
  }
  if (typeof persona !== 'string' || !resolvePersona(persona)) {
    throw new Error(`persona must be one of the 16 MBTI types (e.g. "INTJ") or null to clear`);
  }
  const normalized = persona.trim().toUpperCase() as MbtiType;
  const file = readFile(dataDir);
  file[botId] = normalized;
  writeFile(dataDir, file);
  bot.persona = normalized;
  return normalized;
}

// ---------------------------------------------------------------------------
// Bot avatar picture (chat polish item 8). The avatar is accepted as a
// data URL, size-capped, decoded and stored under
// <dataDir>/bot-avatars/<botId>.<ext>; the profile overlay records only
// metadata, and `avatarUrl` points at the serving route below.
//
// HOST WIRING (parent):
//   applyBotAvatars(seed.bots, config.dataDir);           // at boot
//   app.use('/api', createBotAvatarRouter({ dataDir: config.dataDir, bots }));
//   → PUT /api/bots/:id/avatar { avatar: dataUrl | null }
//     GET /api/bots/:id/avatar  (image bytes)
// ---------------------------------------------------------------------------

import express from 'express';

export const MAX_BOT_AVATAR_BYTES = 256 * 1024;
const AVATAR_MIMES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};
const AVATARS_FILE = 'bot-avatars.json';

type AvatarFile = Record<string, { file: string; mime: string; bytes: number }>;

function readAvatars(dataDir: string): AvatarFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, AVATARS_FILE), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AvatarFile) : {};
  } catch { return {}; }
}
function writeAvatars(dataDir: string, file: AvatarFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = path.join(dataDir, AVATARS_FILE) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, path.join(dataDir, AVATARS_FILE));
}

export function botAvatarUrl(botId: string): string {
  return `/api/bots/${encodeURIComponent(botId)}/avatar`;
}

function safeBotId(botId: string): string { return botId.replace(/[^a-zA-Z0-9_-]/g, '_'); }

/** Validate + store a bot avatar data URL. Null clears it. Throws on bad input / unknown bot. */
export function saveBotAvatar(
  dataDir: string, bots: BotConfig[], botId: string, avatar: unknown,
): { avatarUrl: string | null; bytes?: number; mime?: string } {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot "${botId}"`);
  const overlay = readAvatars(dataDir);
  const prev = overlay[botId];
  if (prev) { try { fs.unlinkSync(path.join(dataDir, 'bot-avatars', prev.file)); } catch { /* ignore */ } delete overlay[botId]; }
  const target = bot as BotConfig & { avatarUrl?: string };
  if (avatar === null || avatar === undefined || avatar === '') {
    writeAvatars(dataDir, overlay);
    delete target.avatarUrl;
    return { avatarUrl: null };
  }
  if (typeof avatar !== 'string') throw new Error('avatar must be a data URL string or null');
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(avatar.trim());
  if (!m) throw new Error('avatar must be a data:image/png|jpeg|webp|gif;base64 URL');
  const buf = Buffer.from((m[2] ?? '').replace(/\s/g, ''), 'base64');
  if (buf.length === 0) throw new Error('avatar image is empty');
  if (buf.length > MAX_BOT_AVATAR_BYTES) throw new Error(`avatar exceeds ${MAX_BOT_AVATAR_BYTES} bytes`);
  const ext = AVATAR_MIMES[m[1] ?? ''] ?? 'png';
  const file = `${safeBotId(botId)}.${ext}`;
  fs.mkdirSync(path.join(dataDir, 'bot-avatars'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'bot-avatars', file), buf);
  overlay[botId] = { file, mime: m[1] ?? 'image/png', bytes: buf.length };
  writeAvatars(dataDir, overlay);
  target.avatarUrl = botAvatarUrl(botId);
  return { avatarUrl: target.avatarUrl, bytes: buf.length, mime: m[1] };
}

/** Stored avatar location for the serving route (null when none). */
export function getBotAvatar(dataDir: string, botId: string): { filePath: string; mime: string; bytes: number } | null {
  const rec = readAvatars(dataDir)[botId];
  if (!rec) return null;
  const filePath = path.join(dataDir, 'bot-avatars', rec.file);
  return fs.existsSync(filePath) ? { filePath, mime: rec.mime, bytes: rec.bytes } : null;
}

/** Apply persisted avatarUrls onto in-memory bots at boot. */
export function applyBotAvatars(bots: BotConfig[], dataDir: string): void {
  const overlay = readAvatars(dataDir);
  for (const bot of bots) {
    if (overlay[bot.id]) (bot as BotConfig & { avatarUrl?: string }).avatarUrl = botAvatarUrl(bot.id);
  }
}

export function createBotAvatarRouter(deps: { dataDir: string; bots: BotConfig[] }): express.Router {
  const router = express.Router();
  router.put('/bots/:id/avatar', (req, res) => {
    try {
      const out = saveBotAvatar(deps.dataDir, deps.bots, req.params.id, (req.body as { avatar?: unknown } | null)?.avatar);
      res.json({ ok: true, botId: req.params.id, ...out });
    } catch (e) { res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
  });
  router.get('/bots/:id/avatar', (req, res) => {
    const rec = getBotAvatar(deps.dataDir, req.params.id);
    if (!rec) { res.status(404).json({ ok: false, error: 'no avatar for this bot' }); return; }
    res.type(rec.mime).sendFile(rec.filePath);
  });
  return router;
}
