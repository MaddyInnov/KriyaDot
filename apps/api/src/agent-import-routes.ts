// SPDX-License-Identifier: Apache-2.0
// Import from other AI agents (Atomic parity): detect Claude Code, Codex,
// OpenCode, OpenClaw, Pi, and Hermes on this machine and import their skills,
// memory files, sessions, and bot configs into KriyaDot.
//
//   GET  /sources                      → detect installed agent tools
//   POST /preview  { sourceId }        → preview importable items
//   POST /run      { sourceId, targetBotId, itemIds, createBot?, botName? }
//                                     → execute the import (additive only)
//
// Safety: detection/preview are read-only on the source dirs; secrets are
// redacted before storage; existing skills/bots are never overwritten —
// collisions are skipped and reported.
//
// HOST WIRING (index.ts):
//   app.use('/api/agent-import', createAgentImportRouter({
//     dataDir: config.dataDir,
//     getBots: () => seed.bots,
//     tieredMemoryStore,
//     sessionStore,
//     audit: (action, fields) => governance.audit(action, fields),
//   }));

import express, { type Router } from 'express';
import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentSourceId,
  BotConfig,
  SessionStore,
  TieredMemoryStore,
} from '@mvp/agent-runtime';
import {
  detectAgentSources,
  loadImportPayload,
  previewAgentImport,
  renderKriyaDotSkill,
  SOURCE_DEFS,
} from '@mvp/agent-runtime';
import { botRosterImportsPath, validateBotRosterManifest } from './bot-roster-routes.js';

// vitest cannot statically resolve `node:sqlite`; load at runtime.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncType = InstanceType<typeof DatabaseSync>;

export interface AgentImportRouterDeps {
  dataDir: string;
  getBots: () => BotConfig[];
  tieredMemoryStore: TieredMemoryStore;
  sessionStore: SessionStore;
  audit: (action: string, fields: Record<string, unknown>) => void;
}

interface ApiError {
  error: string;
  detail?: string;
}

function errorBody(error: string, detail?: string): ApiError {
  return detail ? { error, detail } : { error };
}

function validSourceId(v: unknown): v is AgentSourceId {
  return typeof v === 'string' && SOURCE_DEFS.some((d) => d.id === v);
}

/** Split long memory text into paragraph-ish chunks that fit memory atoms. */
function chunkMemoryText(text: string, maxChunk = 450): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const p of paras) {
    if ((current + ' ' + p).trim().length > maxChunk) {
      if (current) chunks.push(current.trim());
      if (p.length > maxChunk) {
        for (let i = 0; i < p.length; i += maxChunk) chunks.push(p.slice(i, i + maxChunk).trim());
        current = '';
      } else {
        current = p;
      }
    } else {
      current = (current + ' ' + p).trim();
    }
  }
  if (current) chunks.push(current.trim());
  return chunks.slice(0, 40); // cap: 40 atoms per memory file
}

function readImportedBotsFile(dataDir: string): BotConfig[] {
  try {
    const raw = readFileSync(botRosterImportsPath(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((b) => typeof b === 'object' && b !== null) as BotConfig[];
  } catch {
    return [];
  }
}

function writeImportedBotsFile(dataDir: string, bots: BotConfig[]): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = botRosterImportsPath(dataDir) + '.tmp';
  writeFileSync(tmp, JSON.stringify(bots, null, 2), 'utf8');
  renameSync(tmp, botRosterImportsPath(dataDir));
}

export interface ImportRunResult {
  ok: boolean;
  imported: { skills: string[]; memories: number; sessions: string[]; bot?: string };
  skipped: Array<{ id: string; reason: string }>;
  errors: Array<{ id: string; reason: string }>;
}

export function createAgentImportRouter(deps: AgentImportRouterDeps): Router {
  const router = express.Router();
  const home = homedir();
  const skillsDir = join(deps.dataDir, 'skills');

  // Track which imported sessions are archived (read-only) imports.
  const importDb = new DatabaseSync(join(deps.dataDir, 'agent-import.db'));
  importDb.exec(`
    CREATE TABLE IF NOT EXISTS imported_sessions (
      session_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      title TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
  `);

  router.get('/sources', (_req, res) => {
    try {
      res.json({ sources: detectAgentSources(home) });
    } catch (err) {
      res.status(500).json(errorBody('Detection failed', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/preview', (req, res) => {
    const body = (req.body ?? {}) as { sourceId?: unknown };
    if (!validSourceId(body.sourceId)) {
      res.status(400).json(errorBody('body.sourceId must be one of: ' + SOURCE_DEFS.map((d) => d.id).join(', ')));
      return;
    }
    try {
      res.json(previewAgentImport(body.sourceId, home));
    } catch (err) {
      res.status(500).json(errorBody('Preview failed', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/run', (req, res) => {
    const body = (req.body ?? {}) as {
      sourceId?: unknown;
      targetBotId?: unknown;
      itemIds?: unknown;
      createBot?: unknown;
      botName?: unknown;
    };
    if (!validSourceId(body.sourceId)) {
      res.status(400).json(errorBody('body.sourceId is required'));
      return;
    }
    if (typeof body.targetBotId !== 'string' || !body.targetBotId) {
      res.status(400).json(errorBody('body.targetBotId is required'));
      return;
    }
    if (!Array.isArray(body.itemIds) || !body.itemIds.every((i) => typeof i === 'string')) {
      res.status(400).json(errorBody('body.itemIds must be an array of strings'));
      return;
    }
    const targetBot = deps.getBots().find((b) => b.id === body.targetBotId);
    if (!targetBot) {
      res.status(404).json(errorBody(`Unknown bot: ${body.targetBotId}`));
      return;
    }

    const result: ImportRunResult = {
      ok: true,
      imported: { skills: [], memories: 0, sessions: [] },
      skipped: [],
      errors: [],
    };

    let payload;
    try {
      payload = loadImportPayload(body.sourceId, home, body.itemIds as string[]);
    } catch (err) {
      res.status(500).json(errorBody('Failed to load import payload', err instanceof Error ? err.message : String(err)));
      return;
    }

    // 1. Skills → <dataDir>/skills/<name>.md (additive: never overwrite).
    mkdirSync(skillsDir, { recursive: true });
    for (const skill of payload.skills) {
      const file = join(skillsDir, `${skill.name}.md`);
      if (existsSync(file)) {
        result.skipped.push({ id: `skill:${body.sourceId}:${skill.name}`, reason: 'skill already exists — import never overwrites' });
        continue;
      }
      try {
        writeFileSync(file, renderKriyaDotSkill(skill.name, skill.description, skill.content), 'utf8');
        result.imported.skills.push(skill.name);
      } catch (err) {
        result.errors.push({ id: `skill:${body.sourceId}:${skill.name}`, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    // 2. Memory files → durable bot memory atoms (chunked, redacted upstream).
    for (const mem of payload.memories) {
      try {
        for (const chunk of chunkMemoryText(mem.text)) {
          deps.tieredMemoryStore.storeAtom(
            targetBot.id,
            { fact: chunk, entities: [], confidence: 0.8 },
            `agent-import:${body.sourceId}:${mem.path}`,
            undefined,
            { category: mem.category },
          );
          result.imported.memories += 1;
        }
      } catch (err) {
        result.errors.push({ id: `memory:${body.sourceId}:${mem.path}`, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    // 3. Sessions → archived read-only conversations on the target bot.
    for (const sess of payload.sessions) {
      try {
        const sessionId = deps.sessionStore.createSession(targetBot.id);
        for (const m of sess.messages.slice(0, 200)) {
          deps.sessionStore.appendMessage(sessionId, { role: m.role, content: m.content });
        }
        importDb
          .prepare('INSERT INTO imported_sessions (session_id, source, source_ref, title, imported_at) VALUES (?, ?, ?, ?, ?)')
          .run(sessionId, body.sourceId, sess.id, sess.title.slice(0, 120), new Date().toISOString());
        result.imported.sessions.push(sessionId);
      } catch (err) {
        result.errors.push({ id: sess.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    // 4. Bot proposal → new bot (never overwrites; validated like a roster import).
    if (body.createBot === true && payload.botProposal) {
      const proposal = payload.botProposal;
      const rawId =
        typeof body.botName === 'string' && body.botName.trim()
          ? body.botName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
          : `imported-${body.sourceId}`;
      const botId = rawId.slice(0, 64) || `imported-${body.sourceId}`;
      const manifest = {
        version: '1',
        exportedAt: new Date().toISOString(),
        bots: [
          {
            id: botId,
            name: proposal.name,
            description: proposal.description,
            systemPrompt: proposal.systemPrompt,
            provider: proposal.provider,
            model: proposal.model,
            skills: [],
            tools: [],
            mcpServers: [],
          },
        ],
        teams: [],
      };
      const validation = validateBotRosterManifest(manifest);
      if (!validation.ok) {
        result.errors.push({ id: `bot:${body.sourceId}`, reason: validation.errors.join('; ') });
      } else {
        const bot = validation.manifest.bots[0];
        const existing = new Set(deps.getBots().map((b) => b.id));
        if (existing.has(bot.id)) {
          result.skipped.push({ id: `bot:${body.sourceId}`, reason: 'bot id already exists — import never overwrites' });
        } else {
          deps.getBots().push(bot);
          const persisted = readImportedBotsFile(deps.dataDir);
          persisted.push(bot);
          try {
            writeImportedBotsFile(deps.dataDir, persisted);
            result.imported.bot = bot.id;
          } catch (err) {
            result.errors.push({ id: `bot:${body.sourceId}`, reason: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    }

    deps.audit('agent_import.run', {
      actor: 'api',
      detail: {
        source: body.sourceId,
        targetBot: targetBot.id,
        skills: result.imported.skills.length,
        memories: result.imported.memories,
        sessions: result.imported.sessions.length,
        bot: result.imported.bot ?? null,
        skipped: result.skipped.length,
        errors: result.errors.length,
      },
    });
    res.json(result);
  });

  return router;
}
