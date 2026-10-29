// SPDX-License-Identifier: Apache-2.0
// Engine accounts + custom ACP engines settings API (ENGINES pack).
//
//   Claude account profiles (multiple Claude accounts):
//     GET    /api/engine-accounts                 → { ok, profiles } (labels + paths ONLY)
//     POST   /api/engine-accounts                 → create/replace a profile { id, label, configDir }
//     DELETE /api/engine-accounts/:id             → remove a profile
//     GET    /api/engine-accounts/resolve/:botId  → the profile + config dir a bot runs under
//
//   Custom ACP engines (user-defined engines in settings):
//     GET    /api/custom-engines                  → { ok, engines (merged selectable list), custom }
//     POST   /api/custom-engines                  → create/replace { id, label, command, args, env }
//     DELETE /api/custom-engines/:id              → remove
//     POST   /api/custom-engines/:id/probe        → ACP initialize/session-new model discovery probe
//
// HARD RULE: no secret material is ever accepted for storage beyond a
// custom engine's own env map (validated in agent-runtime; foreign
// provider keys are refused there), and no response ever contains
// credential file contents — profiles carry paths + labels only.
//
// Persistence: <dataDir>/engine-accounts.json + <dataDir>/custom-acp-engines.json.
//
// HOST WIRING (index.ts):
//   app.use('/api', createEngineAccountsRouter({
//     dataDir: config.dataDir,
//     bots: seed.bots,
//     audit: (action, fields) => governance.audit(action, fields),
//   }));

import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import {
  listAcpEnginePresets,
  mergeCustomAcpEngines,
  probeCustomAcpEngine,
  publicClaudeProfile,
  resolveClaudeConfigDirForBot,
  selectClaudeProfile,
  validateClaudeProfile,
  validateCustomAcpEngine,
  type BotConfig,
  type ClaudeAccountProfile,
  type CustomAcpEngine,
} from '@mvp/agent-runtime';

const PROFILES_FILE = 'engine-accounts.json';
const CUSTOM_FILE = 'custom-acp-engines.json';

export function engineAccountsPath(dataDir: string): string {
  return path.join(dataDir, PROFILES_FILE);
}

export function customEnginesPath(dataDir: string): string {
  return path.join(dataDir, CUSTOM_FILE);
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Load stored Claude account profiles (invalid entries are skipped, never fatal). */
export function loadClaudeProfiles(dataDir: string, homeDir?: string): ClaudeAccountProfile[] {
  const raw = readJsonFile<{ profiles?: unknown[] }>(engineAccountsPath(dataDir), {});
  const out: ClaudeAccountProfile[] = [];
  for (const entry of raw.profiles ?? []) {
    try {
      out.push(validateClaudeProfile(entry, homeDir));
    } catch {
      // skip malformed stored entries
    }
  }
  return out;
}

export function saveClaudeProfiles(dataDir: string, profiles: readonly ClaudeAccountProfile[]): void {
  writeJsonFile(engineAccountsPath(dataDir), { profiles: profiles.map(publicClaudeProfile) });
}

/** Load stored custom ACP engines (invalid entries are skipped, never fatal). */
export function loadCustomAcpEngines(dataDir: string): CustomAcpEngine[] {
  const raw = readJsonFile<{ engines?: unknown[] }>(customEnginesPath(dataDir), {});
  const out: CustomAcpEngine[] = [];
  for (const entry of raw.engines ?? []) {
    try {
      out.push(validateCustomAcpEngine(entry));
    } catch {
      // skip malformed stored entries
    }
  }
  return out;
}

export function saveCustomAcpEngines(dataDir: string, engines: readonly CustomAcpEngine[]): void {
  writeJsonFile(customEnginesPath(dataDir), { engines });
}

/** The one selectable engine list for bot pickers: presets + customs merged. */
export function getSelectableEngines(dataDir: string) {
  return mergeCustomAcpEngines(listAcpEnginePresets(), loadCustomAcpEngines(dataDir));
}

export interface EngineAccountsDeps {
  dataDir: string;
  /** Bots, for resolve/:botId (the bot's accountProfile field selects the profile). */
  bots?: readonly BotConfig[];
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  homeDir?: string;
  /** Test seam for the probe route (defaults to the real ACP probe). */
  probeFn?: typeof probeCustomAcpEngine;
  /** Workspace dir used as the probe's session cwd (defaults to dataDir). */
  workspaceDir?: string;
}

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

export function createEngineAccountsRouter(deps: EngineAccountsDeps): Router {
  const router = express.Router();
  const probeFn = deps.probeFn ?? probeCustomAcpEngine;

  // ---- Claude account profiles -------------------------------------------

  router.get('/engine-accounts', (_req, res) => {
    const profiles = loadClaudeProfiles(deps.dataDir, deps.homeDir).map(publicClaudeProfile);
    res.json({ ok: true, profiles });
  });

  router.post('/engine-accounts', (req, res) => {
    try {
      const profile = validateClaudeProfile(req.body ?? {}, deps.homeDir);
      const profiles = loadClaudeProfiles(deps.dataDir, deps.homeDir).filter((p) => p.id !== profile.id);
      profiles.push(profile);
      saveClaudeProfiles(deps.dataDir, profiles);
      deps.audit?.('engine_accounts.profile_saved', { actor: 'user', detail: { profile: profile.id } });
      res.status(201).json({ ok: true, profile: publicClaudeProfile(profile) });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'invalid profile'));
    }
  });

  router.delete('/engine-accounts/:id', (req, res) => {
    const before = loadClaudeProfiles(deps.dataDir, deps.homeDir);
    const after = before.filter((p) => p.id !== req.params.id);
    if (after.length === before.length) {
      res.status(404).json(errorBody(`No account profile "${req.params.id}".`));
      return;
    }
    saveClaudeProfiles(deps.dataDir, after);
    deps.audit?.('engine_accounts.profile_deleted', { actor: 'user', detail: { profile: req.params.id } });
    res.json({ ok: true });
  });

  router.get('/engine-accounts/resolve/:botId', (req, res) => {
    const bot = deps.bots?.find((b) => b.id === req.params.botId);
    if (!bot) {
      res.status(404).json(errorBody(`Unknown bot "${req.params.botId}".`));
      return;
    }
    const profiles = loadClaudeProfiles(deps.dataDir, deps.homeDir);
    const profile = selectClaudeProfile(profiles, bot.accountProfile);
    res.json({
      ok: true,
      botId: bot.id,
      accountProfile: bot.accountProfile ?? null,
      profile: profile ? publicClaudeProfile(profile) : null,
      configDir: resolveClaudeConfigDirForBot(profiles, bot.accountProfile, deps.homeDir),
    });
  });

  // ---- Custom ACP engines --------------------------------------------------

  router.get('/custom-engines', (_req, res) => {
    const custom = loadCustomAcpEngines(deps.dataDir);
    res.json({ ok: true, engines: getSelectableEngines(deps.dataDir), custom });
  });

  router.post('/custom-engines', (req, res) => {
    try {
      const engine = validateCustomAcpEngine(req.body ?? {});
      const engines = loadCustomAcpEngines(deps.dataDir).filter((e) => e.id !== engine.id);
      engines.push(engine);
      saveCustomAcpEngines(deps.dataDir, engines);
      deps.audit?.('custom_engines.saved', { actor: 'user', detail: { engine: engine.id } });
      res.status(201).json({ ok: true, engine });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'invalid custom engine'));
    }
  });

  router.delete('/custom-engines/:id', (req, res) => {
    const before = loadCustomAcpEngines(deps.dataDir);
    const after = before.filter((e) => e.id !== req.params.id);
    if (after.length === before.length) {
      res.status(404).json(errorBody(`No custom engine "${req.params.id}".`));
      return;
    }
    saveCustomAcpEngines(deps.dataDir, after);
    deps.audit?.('custom_engines.deleted', { actor: 'user', detail: { engine: req.params.id } });
    res.json({ ok: true });
  });

  router.post('/custom-engines/:id/probe', async (req, res) => {
    const engine = loadCustomAcpEngines(deps.dataDir).find((e) => e.id === req.params.id);
    if (!engine) {
      res.status(404).json(errorBody(`No custom engine "${req.params.id}".`));
      return;
    }
    try {
      const result = await probeFn(engine, { cwd: deps.workspaceDir ?? deps.dataDir });
      deps.audit?.('custom_engines.probed', {
        actor: 'user',
        detail: { engine: engine.id, models: result.models.length },
      });
      res.json({ ok: true, agentName: result.agentName, models: result.models });
    } catch (err) {
      res.status(502).json(errorBody(err instanceof Error ? err.message : 'probe failed'));
    }
  });

  return router;
}
