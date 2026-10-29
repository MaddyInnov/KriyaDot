// SPDX-License-Identifier: Apache-2.0
// Per-bot "Works on" computer surfaces: persistence overlay.
//
// Bot configs ship in seed/bots.json (immutable at runtime). Like
// bot-policies.ts, the user's per-bot computer surface choices live in a
// dataDir overlay file — computer-surfaces.json — applied onto the in-memory
// BotConfig objects at boot:
//
//   { "surfaces": { "<botId>": "docker" },
//     "pins": { "<botId>:<conversationId>": "browser" } }

import fs from 'node:fs';
import path from 'node:path';
import type { BotConfig, ComputerProvider, ComputerSurface, PerBotComputerManager } from '@mvp/agent-runtime';
import { isComputerProvider, isComputerSurface, resolveComputerProvider } from '@mvp/agent-runtime';

const SURFACES_FILE = 'computer-surfaces.json';

export function botComputerSurfacesPath(dataDir: string): string {
  return path.join(dataDir, SURFACES_FILE);
}

interface SurfaceOverlayFile {
  surfaces: Record<string, ComputerSurface>;
  pins: Record<string, ComputerSurface>;
  providers: Record<string, ComputerProvider>;
}

function emptyOverlay(): SurfaceOverlayFile {
  return { surfaces: {}, pins: {}, providers: {} };
}

export { resolveComputerProvider };

/** Load + validate the overlay file. Invalid entries are dropped with a warning. */
export function loadComputerSurfaceOverlay(dataDir: string): SurfaceOverlayFile {
  const out = emptyOverlay();
  try {
    const raw = fs.readFileSync(botComputerSurfacesPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SurfaceOverlayFile>;
    if (typeof parsed !== 'object' || parsed === null) return out;
    for (const section of ['surfaces', 'pins'] as const) {
      const entries = parsed[section];
      if (typeof entries !== 'object' || entries === null) continue;
      for (const [key, value] of Object.entries(entries)) {
        if (typeof key !== 'string' || key.length === 0 || key.length > 256) continue;
        if (!isComputerSurface(value)) {
          console.warn(`[computer-surfaces] dropping invalid surface "${String(value)}" for "${key}"`);
          continue;
        }
        out[section][key] = value;
      }
    }
    const providers = (parsed as { providers?: unknown }).providers;
    if (typeof providers === 'object' && providers !== null) {
      for (const [key, value] of Object.entries(providers as Record<string, unknown>)) {
        if (key.length === 0 || key.length > 256) continue;
        if (!isComputerProvider(value)) continue;
        out.providers[key] = value;
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[computer-surfaces] could not read ${SURFACES_FILE}: ${(err as Error).message}`);
    }
    return out;
  }
}

function writeOverlay(dataDir: string, overlay: SurfaceOverlayFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(botComputerSurfacesPath(dataDir), JSON.stringify(overlay, null, 2) + '\n', {
    mode: 0o600,
  });
}

/** Apply the overlay onto in-memory bot configs (mutates the array entries). */
export function applyComputerSurfaces(bots: BotConfig[], dataDir: string): SurfaceOverlayFile {
  const overlay = loadComputerSurfaceOverlay(dataDir);
  const ids = Object.keys(overlay.surfaces);
  for (const bot of bots) {
    const surface = overlay.surfaces[bot.id];
    if (surface && !bot.computerSurface) {
      bot.computerSurface = surface;
    }
    const provider = overlay.providers[bot.id];
    if (provider && !bot.computerProvider) {
      bot.computerProvider = provider;
    }
  }
  if (ids.length > 0) {
    console.log(`[computer-surfaces] applied per-bot surfaces for ${ids.length} bot(s)`);
  }
  return overlay;
}

/** Persist one bot's configured computer provider and update the in-memory bot. */
export function saveBotComputerProvider(
  dataDir: string,
  bots: BotConfig[],
  botId: string,
  provider: unknown,
): ComputerProvider {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot "${botId}"`);
  if (!isComputerProvider(provider)) {
    throw new Error(`"computerProvider" must be one of auto, mock, playwright, desktop, docker (got ${JSON.stringify(provider)})`);
  }
  const overlay = loadComputerSurfaceOverlay(dataDir);
  overlay.providers[botId] = provider;
  writeOverlay(dataDir, overlay);
  bot.computerProvider = provider;
  return provider;
}

/** Which computer backend is active for a bot, and why (config|env|auto|unavailable). */
export function computerProviderReport(bot: BotConfig, env: NodeJS.ProcessEnv = process.env) {
  const resolution = resolveComputerProvider({
    configProvider: bot.computerProvider ?? null,
    env,
    surface: bot.computerSurface,
  });
  return {
    botId: bot.id,
    computerProvider: bot.computerProvider ?? 'auto',
    activeBackend: resolution.backend,
    source: resolution.source,
    reason: resolution.reason,
  };
}

/** Persist one bot's "Works on" surface and update the in-memory bot. */
export function saveBotComputerSurface(
  dataDir: string,
  bots: BotConfig[],
  botId: string,
  surface: unknown,
): ComputerSurface {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot "${botId}"`);
  if (!isComputerSurface(surface)) {
    throw new Error(
      `"surface" must be one of auto, local, docker, browser, vps, off (got ${JSON.stringify(surface)})`,
    );
  }
  const overlay = loadComputerSurfaceOverlay(dataDir);
  overlay.surfaces[botId] = surface;
  writeOverlay(dataDir, overlay);
  bot.computerSurface = surface;
  return surface;
}

/** Persist a per-conversation surface pin (surface null clears it). */
export function saveComputerSurfacePin(
  dataDir: string,
  botId: string,
  conversationId: string,
  surface: ComputerSurface | null,
): void {
  if (!conversationId || conversationId.length > 256) {
    throw new Error('"conversationId" must be a non-empty string (max 256 chars)');
  }
  if (surface !== null && !isComputerSurface(surface)) {
    throw new Error('"surface" must be one of auto, local, docker, browser, vps, off');
  }
  const overlay = loadComputerSurfaceOverlay(dataDir);
  const key = `${botId}:${conversationId}`;
  if (surface === null) delete overlay.pins[key];
  else overlay.pins[key] = surface;
  writeOverlay(dataDir, overlay);
}

/** Pins for one bot, from the overlay file. */
export function loadComputerSurfacePins(
  dataDir: string,
  botId: string,
): Array<{ conversationId: string; surface: ComputerSurface }> {
  const overlay = loadComputerSurfaceOverlay(dataDir);
  const out: Array<{ conversationId: string; surface: ComputerSurface }> = [];
  for (const [key, surface] of Object.entries(overlay.pins)) {
    if (key.startsWith(`${botId}:`)) {
      out.push({ conversationId: key.slice(botId.length + 1), surface });
    }
  }
  return out;
}

/** Load persisted conversation pins into the manager at boot. */
export function applyComputerSurfacePins(
  manager: PerBotComputerManager,
  dataDir: string,
): number {
  const overlay = loadComputerSurfaceOverlay(dataDir);
  let count = 0;
  for (const [key, surface] of Object.entries(overlay.pins)) {
    const sep = key.indexOf(':');
    if (sep <= 0) continue;
    manager.pinSurface(key.slice(0, sep), key.slice(sep + 1), surface);
    count += 1;
  }
  if (count > 0) {
    console.log(`[computer-surfaces] applied ${count} conversation surface pin(s)`);
  }
  return count;
}
