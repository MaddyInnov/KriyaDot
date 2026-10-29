// SPDX-License-Identifier: Apache-2.0
// Bot roster import/export.
//
//   GET  /export → downloadable JSON manifest { version, exportedAt, bots, teams }
//   POST /import { manifest } → validate, dedupe by id, create new bots/teams
//
// The manifest is a portable snapshot of the bot roster (bot configs +
// agent-team definitions) for backup, review, and moving rosters between
// KriyaDot installs. Import NEVER overwrites: ids that already exist are
// skipped and reported, and every malformed manifest or entry is rejected
// with 400 + details.
//
// Bot configs ship in seed/bots.json (immutable at runtime). Imported bots
// are appended to the in-memory bot list and persisted to
// <dataDir>/bot-roster-imports.json so they survive restarts (applied at
// boot via applyImportedBots, alongside the persona/workspace/policy
// overlays).
//
// HOST WIRING (index.ts — this module is not mounted by itself):
//   import { applyImportedBots, createBotRosterRouter } from './bot-roster-routes.js';
//   applyImportedBots(seed.bots, config.dataDir); // in boot(), after the other apply* overlays
//   app.use('/api/bots', createBotRosterRouter({
//     dataDir: config.dataDir,
//     getBots: () => seed.bots,
//     audit: (action, fields) => governance.audit(action, fields),
//   }));

import express, { type Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  TeamStore,
  resolvePersona,
  validateApprovalMode,
  type ApprovalMode,
  type BotConfig,
  type BotPolicy,
  type BotPolicyRule,
  type SandboxMode,
  type Team,
} from '@mvp/agent-runtime';

export const BOT_ROSTER_MANIFEST_VERSION = '1';

const ROSTER_IMPORTS_FILE = 'bot-roster-imports.json';

export interface BotRosterManifest {
  version: string;
  exportedAt: string;
  bots: BotConfig[];
  teams: Team[];
}

export interface RosterSkipped {
  id: string;
  reason: string;
}

export interface RosterImportResult {
  ok: true;
  imported: string[];
  skipped: RosterSkipped[];
  errors: RosterSkipped[];
}

export interface BotRosterDeps {
  dataDir: string;
  /** Live bot list — import appends created bots to this array. */
  getBots: () => BotConfig[];
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /**
   * Direct-delete cascade hooks (bot lifecycle, mirroring the Chief-proposal
   * deletion cleanup in chief-routes.ts): called after a bot is removed so
   * the host can tear down per-bot state (private MCP servers, sessions).
   * Optional; failures are swallowed so teardown never blocks a delete.
   */
  onBotDeleted?: (botId: string) => void | Promise<void>;
  /**
   * Persist a deletion for bots that did NOT come from the roster imports
   * file (seed bots) — host wires this to ChiefTeamsStore.addDeletedBotId.
   * When absent, only imports-file bots are durably deleted.
   */
  recordDeletedBotId?: (botId: string) => void;
}

function errorBody(message: string, detail?: unknown): Record<string, unknown> {
  return { ok: false, error: message, ...(detail !== undefined ? { detail } : {}) };
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

const POLICY_EFFECTS = ['allow', 'deny', 'require-approval'] as const;
const SANDBOX_MODES: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

// ---- Persistence (imported bots survive restarts) ----------------------------

export function botRosterImportsPath(dataDir: string): string {
  return path.join(dataDir, ROSTER_IMPORTS_FILE);
}

function readImportedBots(dataDir: string): BotConfig[] {
  try {
    const raw = fs.readFileSync(botRosterImportsPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((b) => typeof b === 'object' && b !== null) as BotConfig[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function writeImportedBots(dataDir: string, bots: BotConfig[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = botRosterImportsPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(bots, null, 2), 'utf8');
  fs.renameSync(tmp, botRosterImportsPath(dataDir));
}

/**
 * Apply previously imported bots onto the in-memory bot list. Call at boot
 * (HOST WIRING: index.ts, after seed load, next to the other apply* calls).
 * Entries whose id already exists are ignored — import never overwrites.
 */
export function applyImportedBots(bots: BotConfig[], dataDir: string): void {
  const existing = new Set(bots.map((b) => b.id));
  for (const imported of readImportedBots(dataDir)) {
    if (typeof imported.id !== 'string' || existing.has(imported.id)) continue;
    bots.push(imported);
    existing.add(imported.id);
  }
}

/**
 * Append one bot to the roster imports file (used when an approved
 * chief-of-staff create proposal adds a bot). The entry survives restarts
 * via applyImportedBots.
 */
export function appendRosterImport(bot: BotConfig, dataDir: string): void {
  const bots = readImportedBots(dataDir);
  bots.push(bot);
  writeImportedBots(dataDir, bots);
}

/** True when the bot id lives in the roster imports file. */
export function isRosterImport(botId: string, dataDir: string): boolean {
  return readImportedBots(dataDir).some((b) => b.id === botId);
}

/**
 * Replace one bot entry in the roster imports file. Returns true when the
 * entry existed and was replaced.
 */
export function updateRosterImport(bot: BotConfig, dataDir: string): boolean {
  const bots = readImportedBots(dataDir);
  const idx = bots.findIndex((b) => b.id === bot.id);
  if (idx === -1) return false;
  bots[idx] = bot;
  writeImportedBots(dataDir, bots);
  return true;
}

/**
 * Remove one bot from the roster imports file. Returns true when removed.
 */
export function removeRosterImport(botId: string, dataDir: string): boolean {
  const bots = readImportedBots(dataDir);
  const kept = bots.filter((b) => b.id !== botId);
  if (kept.length === bots.length) return false;
  writeImportedBots(dataDir, kept);
  return true;
}

// ---- Manifest validation -----------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string');
}

/** Validate one bot entry; returns sanitized BotConfig or error strings. */
function validateBotEntry(raw: unknown, index: number): { bot?: BotConfig; errors: string[] } {
  const where = `bots[${index}]`;
  const errors: string[] = [];
  if (!isRecord(raw)) return { errors: [`${where}: must be an object`] };
  const id = raw.id;
  if (typeof id !== 'string' || !validId(id)) {
    errors.push(`${where}.id: must be 1-64 chars of letters, digits, _ or -`);
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) errors.push(`${where}.name: must be a non-empty string`);
  for (const f of ['description', 'systemPrompt', 'provider', 'model'] as const) {
    if (typeof raw[f] !== 'string') errors.push(`${where}.${f}: must be a string`);
  }
  for (const f of ['skills', 'tools', 'mcpServers'] as const) {
    if (!stringArray(raw[f])) errors.push(`${where}.${f}: must be an array of strings`);
  }
  if (errors.length > 0) return { errors };

  const bot: BotConfig = {
    id: (id as string).trim(),
    name: (raw.name as string).trim().slice(0, 120),
    description: raw.description as string,
    systemPrompt: raw.systemPrompt as string,
    provider: raw.provider as string,
    model: raw.model as string,
    skills: [...(raw.skills as string[])],
    tools: [...(raw.tools as string[])],
    mcpServers: [...(raw.mcpServers as string[])],
  };

  if (raw.policy !== undefined) {
    if (!isRecord(raw.policy) || !Array.isArray(raw.policy.rules)) {
      errors.push(`${where}.policy: must be an object with a rules array`);
    } else {
      const rules: BotPolicyRule[] = [];
      raw.policy.rules.forEach((r: unknown, i: number) => {
        if (!isRecord(r) || typeof r.id !== 'string' || typeof r.toolPattern !== 'string') {
          errors.push(`${where}.policy.rules[${i}]: needs string id and toolPattern`);
          return;
        }
        if (typeof r.effect !== 'string' || !(POLICY_EFFECTS as readonly string[]).includes(r.effect)) {
          errors.push(`${where}.policy.rules[${i}].effect: must be allow|deny|require-approval`);
          return;
        }
        rules.push({
          id: r.id,
          toolPattern: r.toolPattern,
          effect: r.effect as BotPolicyRule['effect'],
          ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
        });
      });
      if (errors.length === 0) (bot as { policy?: BotPolicy }).policy = { rules };
    }
  }
  if (raw.sandboxMode !== undefined) {
    if (typeof raw.sandboxMode !== 'string' || !SANDBOX_MODES.includes(raw.sandboxMode as SandboxMode)) {
      errors.push(`${where}.sandboxMode: must be one of ${SANDBOX_MODES.join('|')}`);
    } else {
      bot.sandboxMode = raw.sandboxMode as SandboxMode;
    }
  }
  if (raw.persona !== undefined && raw.persona !== null) {
    if (typeof raw.persona !== 'string' || !resolvePersona(raw.persona)) {
      errors.push(`${where}.persona: must be one of the 16 MBTI types or null`);
    } else {
      bot.persona = raw.persona.trim().toUpperCase();
    }
  }
  if (raw.workspace !== undefined) {
    if (typeof raw.workspace !== 'string') errors.push(`${where}.workspace: must be a string`);
    else if (raw.workspace) bot.workspace = raw.workspace;
  }
  if (raw.notifications !== undefined) {
    if (typeof raw.notifications !== 'string' || !['all', 'approvals', 'none'].includes(raw.notifications)) {
      errors.push(`${where}.notifications: must be one of all|approvals|none`);
    } else {
      bot.notifications = raw.notifications as BotConfig['notifications'];
    }
  }
  if (raw.approvalMode !== undefined) {
    const v = validateApprovalMode(raw.approvalMode, where);
    if (v.errors.length > 0) errors.push(...v.errors);
    else if (v.mode) bot.approvalMode = v.mode as ApprovalMode;
  }
  if (raw.voice !== undefined) {
    const vErr = validateVoiceSettings(raw.voice, `${where}.voice`);
    if (vErr.errors.length > 0) errors.push(...vErr.errors);
    else if (vErr.voice) bot.voice = vErr.voice;
  }
  return errors.length > 0 ? { errors } : { bot, errors };
}

/** Validate per-bot voice-call settings (Codync parity: realtime voice calls). */
export function validateVoiceSettings(
  raw: unknown,
  where: string,
): { voice?: BotConfig['voice']; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { errors: [`${where}: must be an object`] };
  }
  const r = raw as Record<string, unknown>;
  const voice: NonNullable<BotConfig['voice']> = {};
  const providers = ['mock', 'groq', 'openai'];
  for (const key of ['sttProvider', 'ttsProvider'] as const) {
    if (r[key] !== undefined) {
      if (typeof r[key] !== 'string' || !providers.includes(r[key])) {
        errors.push(`${where}.${key}: must be one of ${providers.join('|')}`);
      } else {
        voice[key] = r[key] as 'mock' | 'groq' | 'openai';
      }
    }
  }
  if (r.ttsVoice !== undefined) {
    if (typeof r.ttsVoice !== 'string' || !r.ttsVoice.trim() || r.ttsVoice.length > 120) {
      errors.push(`${where}.ttsVoice: must be a non-empty string (max 120 chars)`);
    } else {
      voice.ttsVoice = r.ttsVoice.trim();
    }
  }
  if (r.autoVad !== undefined) {
    if (typeof r.autoVad !== 'boolean') errors.push(`${where}.autoVad: must be a boolean`);
    else voice.autoVad = r.autoVad;
  }
  if (r.vadSensitivity !== undefined) {
    if (
      typeof r.vadSensitivity !== 'number' ||
      !Number.isFinite(r.vadSensitivity) ||
      r.vadSensitivity < 1 ||
      r.vadSensitivity > 10
    ) {
      errors.push(`${where}.vadSensitivity: must be a number between 1 and 10`);
    } else {
      voice.vadSensitivity = r.vadSensitivity;
    }
  }
  return { voice: Object.keys(voice).length > 0 ? voice : undefined, errors };
}

/** Validate one team entry. Bot references are checked at import time. */
function validateTeamEntry(raw: unknown, index: number): { team?: Team; errors: string[] } {
  const where = `teams[${index}]`;
  const errors: string[] = [];
  if (!isRecord(raw)) return { errors: [`${where}: must be an object`] };
  if (typeof raw.id !== 'string' || !validId(raw.id)) {
    errors.push(`${where}.id: must be 1-64 chars of letters, digits, _ or -`);
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) errors.push(`${where}.name: must be a non-empty string`);
  if (typeof raw.coordinatorBotId !== 'string' || !raw.coordinatorBotId.trim()) {
    errors.push(`${where}.coordinatorBotId: must be a non-empty string`);
  }
  if (!stringArray(raw.memberBotIds)) errors.push(`${where}.memberBotIds: must be an array of strings`);
  if (errors.length > 0) return { errors };
  return {
    team: {
      id: (raw.id as string).trim(),
      name: (raw.name as string).trim().slice(0, 120),
      coordinatorBotId: (raw.coordinatorBotId as string).trim(),
      memberBotIds: [...new Set((raw.memberBotIds as string[]).map((m) => m.trim()).filter(Boolean))],
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    },
    errors,
  };
}

export type ManifestValidation =
  | { ok: true; manifest: BotRosterManifest }
  | { ok: false; errors: string[] };

/**
 * Pure manifest validation — no I/O, no side effects. Used by POST /import
 * (400 + details on failure) and directly by tests.
 */
export function validateBotRosterManifest(input: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['manifest: must be an object'] };
  if (typeof input.version !== 'string' || !input.version) {
    errors.push('manifest.version: must be a non-empty string');
  }
  if (typeof input.exportedAt !== 'string' || !input.exportedAt) {
    errors.push('manifest.exportedAt: must be an ISO timestamp string');
  }
  if (!Array.isArray(input.bots)) errors.push('manifest.bots: must be an array');
  if (!Array.isArray(input.teams)) errors.push('manifest.teams: must be an array');
  if (errors.length > 0) return { ok: false, errors };

  const bots: BotConfig[] = [];
  (input.bots as unknown[]).forEach((raw, i) => {
    const r = validateBotEntry(raw, i);
    errors.push(...r.errors);
    if (r.bot) bots.push(r.bot);
  });
  const teams: Team[] = [];
  (input.teams as unknown[]).forEach((raw, i) => {
    const r = validateTeamEntry(raw, i);
    errors.push(...r.errors);
    if (r.team) teams.push(r.team);
  });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      version: input.version as string,
      exportedAt: input.exportedAt as string,
      bots,
      teams,
    },
  };
}

// ---- Router ------------------------------------------------------------------

export function createBotRosterRouter(deps: BotRosterDeps): Router {
  const router = express.Router();
  const teamStore = new TeamStore(deps.dataDir);

  /** Downloadable JSON snapshot of the whole roster. */
  router.get('/export', (_req, res) => {
    const manifest: BotRosterManifest = {
      version: BOT_ROSTER_MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      bots: deps.getBots(),
      teams: teamStore.listTeams(),
    };
    const stamp = manifest.exportedAt.slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="kriyadot-bot-roster-${stamp}.json"`);
    deps.audit('bots.roster_export', {
      actor: 'api',
      detail: { bots: manifest.bots.length, teams: manifest.teams.length },
    });
    res.json(manifest);
  });

  /**
   * Import a roster manifest. Never overwrites: existing bot/team ids are
   * skipped (reported), malformed entries land in `errors`, everything else
   * is created with its manifest id preserved.
   */
  router.post('/import', async (req, res) => {
    const body = (req.body ?? {}) as { manifest?: unknown };
    if (body.manifest === undefined) {
      res.status(400).json(errorBody('body.manifest is required'));
      return;
    }
    const validation = validateBotRosterManifest(body.manifest);
    if (!validation.ok) {
      res.status(400).json(errorBody('Invalid bot roster manifest', validation.errors));
      return;
    }
    const { manifest } = validation;
    const result: RosterImportResult = { ok: true, imported: [], skipped: [], errors: [] };

    const bots = deps.getBots();
    const botIds = new Set(bots.map((b) => b.id));
    const persisted = readImportedBots(deps.dataDir);
    const { allocateBotWorkspace } = await import('./bot-workspace-alloc.js');
    for (const bot of manifest.bots) {
      if (botIds.has(bot.id)) {
        result.skipped.push({ id: bot.id, reason: 'bot id already exists — import never overwrites' });
        continue;
      }
      // Auto-allocate a workspace for the imported bot (Codync parity).
      try {
        allocateBotWorkspace(bot, deps.dataDir);
      } catch {
        // Invalid bot id — workspace allocation is best-effort on import.
      }
      bots.push(bot);
      botIds.add(bot.id);
      persisted.push(bot);
      result.imported.push(bot.id);
    }
    if (result.imported.length > 0) {
      // `persisted` already holds the previous file contents plus the new
      // bots pushed above — rewrite the file wholesale.
      writeImportedBots(deps.dataDir, persisted);
    }

    const teamIds = new Set(teamStore.listTeams().map((t) => t.id));
    for (const team of manifest.teams) {
      if (teamIds.has(team.id)) {
        result.skipped.push({ id: team.id, reason: 'team id already exists — import never overwrites' });
        continue;
      }
      if (!botIds.has(team.coordinatorBotId)) {
        result.errors.push({ id: team.id, reason: `unknown coordinatorBotId "${team.coordinatorBotId}"` });
        continue;
      }
      const unknownMember = team.memberBotIds.find((m) => !botIds.has(m));
      if (unknownMember) {
        result.errors.push({ id: team.id, reason: `unknown memberBotId "${unknownMember}"` });
        continue;
      }
      try {
        teamStore.importTeam(team);
        teamIds.add(team.id);
        result.imported.push(team.id);
      } catch (err) {
        result.errors.push({ id: team.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    deps.audit('bots.roster_import', {
      actor: 'api',
      detail: {
        imported: result.imported.length,
        skipped: result.skipped.length,
        errors: result.errors.length,
      },
    });
    res.json(result);
  });

  /**
   * Direct create (bot lifecycle): POST /bots with a single bot config.
   * Same validation + defaults the setup flow applies (missing provider /
   * model fall back to the first existing bot's, else groq/gpt-oss-20b;
   * missing string/array fields default to '' / []), workspace allocation
   * is best-effort, the bot is appended to the live list AND the roster
   * imports file so it survives restarts. Duplicate ids → 409.
   */
  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawBot = (typeof body.bot === 'object' && body.bot !== null ? body.bot : body) as Record<string, unknown>;
    const bots = deps.getBots();
    const fallback = bots[0];
    const withDefaults: Record<string, unknown> = {
      description: '',
      systemPrompt: '',
      provider: fallback?.provider ?? 'groq',
      model: fallback?.model ?? 'gpt-oss-20b',
      skills: [],
      tools: [],
      mcpServers: [],
      ...rawBot,
    };
    const validation = validateBotEntry(withDefaults, 0);
    if (!validation.bot) {
      res.status(400).json(errorBody('Invalid bot config', validation.errors));
      return;
    }
    const bot = validation.bot;
    if (bots.some((b) => b.id === bot.id)) {
      res.status(409).json(errorBody(`bot id "${bot.id}" already exists`));
      return;
    }
    try {
      const { allocateBotWorkspace } = await import('./bot-workspace-alloc.js');
      allocateBotWorkspace(bot, deps.dataDir);
    } catch {
      // Invalid bot id — workspace allocation is best-effort (import parity).
    }
    bots.push(bot);
    appendRosterImport(bot, deps.dataDir);
    deps.audit('bots.created', { actor: 'api', detail: { botId: bot.id, name: bot.name } });
    res.status(201).json({ ok: true, bot });
  });

  /**
   * Direct delete (bot lifecycle): DELETE /bots/:id. Cascade mirrors the
   * Chief-proposal deletion cleanup: refuse to delete the chief of staff,
   * remove from the live list, run the host teardown hook, remove from the
   * roster imports file — or, for seed bots, record the deletion via
   * deps.recordDeletedBotId — and scrub the bot from any team's member /
   * coordinator references that this router can reach (TeamStore).
   * Unknown id → 404. Audit-logged as bots.deleted.
   */
  router.delete('/:id', (req, res) => {
    const bots = deps.getBots();
    const idx = bots.findIndex((b) => b.id === req.params.id);
    if (idx === -1) {
      res.status(404).json(errorBody(`unknown bot "${req.params.id}"`));
      return;
    }
    const target = bots[idx]!;
    if (target.chiefOfStaff === true) {
      res.status(409).json(errorBody(`cannot delete the chief of staff ("${target.id}") — remove the chief first`));
      return;
    }
    bots.splice(idx, 1);
    if (deps.onBotDeleted) {
      try {
        void Promise.resolve(deps.onBotDeleted(target.id)).catch(() => undefined);
      } catch {
        // teardown must never block the delete
      }
    }
    if (!removeRosterImport(target.id, deps.dataDir)) {
      deps.recordDeletedBotId?.(target.id);
    }
    // Team cascade: drop the bot from team membership; a team whose
    // coordinator is deleted is removed entirely (it cannot run).
    try {
      for (const team of teamStore.listTeams()) {
        if (team.coordinatorBotId === target.id) {
          (teamStore as unknown as { deleteTeam?: (id: string) => void }).deleteTeam?.(team.id);
        }
      }
    } catch {
      // Team cascade is best-effort; the bot itself is already deleted.
    }
    deps.audit('bots.deleted', { actor: 'api', detail: { botId: target.id } });
    res.json({ ok: true, deleted: target.id });
  });

  return router;
}
