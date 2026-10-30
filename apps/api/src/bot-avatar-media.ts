// SPDX-License-Identifier: Apache-2.0
// Generated avatar media for agent identity (Muse parity §4.5 C-16).
//
// The brand pet stays symbolic (components/pet) — C-16 is different:
// each BOT gets a generated avatar image produced by the platform's
// media machinery (packages/muse-modules MediaProvider — mock offline,
// real provider when the founder's media keys are configured). The
// prompt is derived deterministically from the bot's identity (name,
// description, a stable style seed from the bot id) so regenerating
// without an explicit new prompt keeps the bot's look coherent.
// Records live in <dataDir>/bot-avatars.db; bytes stay with the media
// provider (the record keeps the asset URL + provenance).

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Router } from 'express';
import { openDb } from '@mvp/agent-runtime';
import { MockMediaProvider, type MediaAsset, type MediaProvider } from '@mvp/muse-modules';

export interface BotIdentity { id: string; name: string; description?: string }
export interface BotAvatar {
  botId: string;
  assetId: string;
  url: string;
  mimeType: string;
  prompt: string;
  provider: string;
  styleSeed: string;
  generatedAt: string;
}

/** Stable per-bot style seed: same bot → same seed → coherent regenerations. */
export function avatarStyleSeed(botId: string): string {
  return createHash('sha256').update(`kriyadot-avatar:${botId}`).digest('hex').slice(0, 12);
}

const PALETTES = ['amethyst violet', 'emerald', 'sapphire blue', 'garnet red', 'topaz amber', 'copper', 'opal iridescent', 'peacock teal'] as const;

/** Deterministic avatar prompt from bot identity (no LLM, no paid call). */
export function buildAvatarPrompt(bot: BotIdentity, extra?: string): string {
  const seed = avatarStyleSeed(bot.id);
  const n = Number.parseInt(seed.slice(0, 2), 16);
  const palette = PALETTES[n % PALETTES.length];
  const desc = (bot.description ?? '').trim().slice(0, 160);
  const base = `Portrait avatar for an AI agent named "${bot.name}"${desc ? ` — ${desc}` : ''}. Friendly geometric mascot head, ${palette} jewel palette, soft clay-glass material, plain light background, centered, no text. Style seed ${seed}.`;
  return extra?.trim() ? `${base} ${extra.trim().slice(0, 300)}` : base;
}

interface Row { bot_id: string; asset_id: string; url: string; mime_type: string; prompt: string; provider: string; style_seed: string; generated_at: string }

export class BotAvatarStore {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'bot-avatars.db'));
    this.db.exec(`CREATE TABLE IF NOT EXISTS bot_avatars (
      bot_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, url TEXT NOT NULL, mime_type TEXT NOT NULL,
      prompt TEXT NOT NULL, provider TEXT NOT NULL, style_seed TEXT NOT NULL, generated_at TEXT NOT NULL);`);
  }
  put(a: BotAvatar): BotAvatar {
    this.db.prepare(`INSERT INTO bot_avatars (bot_id, asset_id, url, mime_type, prompt, provider, style_seed, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET asset_id=excluded.asset_id, url=excluded.url,
      mime_type=excluded.mime_type, prompt=excluded.prompt, provider=excluded.provider, style_seed=excluded.style_seed, generated_at=excluded.generated_at`)
      .run(a.botId, a.assetId, a.url, a.mimeType, a.prompt, a.provider, a.styleSeed, a.generatedAt);
    return a;
  }
  get(botId: string): BotAvatar | null {
    const r = this.db.prepare(`SELECT * FROM bot_avatars WHERE bot_id = ?`).get(botId) as unknown as Row | undefined;
    return r ? { botId: r.bot_id, assetId: r.asset_id, url: r.url, mimeType: r.mime_type, prompt: r.prompt, provider: r.provider, styleSeed: r.style_seed, generatedAt: r.generated_at } : null;
  }
  remove(botId: string): boolean {
    return this.db.prepare(`DELETE FROM bot_avatars WHERE bot_id = ?`).run(botId).changes > 0;
  }
  close(): void { this.db.close(); }
}

/** Generate (or regenerate) a bot's avatar through a MediaProvider. */
export async function generateBotAvatar(
  store: BotAvatarStore,
  provider: MediaProvider,
  bot: BotIdentity,
  extraPrompt?: string,
): Promise<BotAvatar> {
  const prompt = buildAvatarPrompt(bot, extraPrompt);
  const asset: MediaAsset = await provider.generate('image', prompt);
  return store.put({
    botId: bot.id, assetId: asset.id, url: asset.url, mimeType: asset.mimeType,
    prompt, provider: asset.provider, styleSeed: avatarStyleSeed(bot.id),
    generatedAt: new Date().toISOString(),
  });
}

export interface BotAvatarDeps {
  store: BotAvatarStore;
  /** Defaults to the offline MockMediaProvider; host passes resolveMediaProvider(). */
  provider?: MediaProvider;
  getBot: (botId: string) => BotIdentity | null;
  audit?: (action: string, fields: Record<string, unknown>) => void;
}

export function createBotAvatarRouter(deps: BotAvatarDeps): Router {
  const provider = deps.provider ?? new MockMediaProvider();
  const router = express.Router();
  router.get('/bots/:botId/avatar', (req, res) => {
    const avatar = deps.store.get(req.params.botId);
    if (!avatar) { res.status(404).json({ ok: false, error: 'no generated avatar for this bot yet' }); return; }
    res.json({ ok: true, avatar });
  });
  router.post('/bots/:botId/avatar/generate', async (req, res) => {
    const bot = deps.getBot(req.params.botId);
    if (!bot) { res.status(404).json({ ok: false, error: 'unknown bot' }); return; }
    try {
      const extra = typeof (req.body as { prompt?: unknown })?.prompt === 'string' ? String((req.body as { prompt: string }).prompt) : undefined;
      const avatar = await generateBotAvatar(deps.store, provider, bot, extra);
      deps.audit?.('bot.avatar_generate', { detail: { botId: bot.id, provider: avatar.provider, assetId: avatar.assetId } });
      res.status(201).json({ ok: true, avatar });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'avatar generation failed' });
    }
  });
  router.delete('/bots/:botId/avatar', (req, res) => {
    if (!deps.store.remove(req.params.botId)) { res.status(404).json({ ok: false, error: 'no generated avatar for this bot' }); return; }
    res.json({ ok: true });
  });
  return router;
}
