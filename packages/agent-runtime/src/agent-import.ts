// SPDX-License-Identifier: Apache-2.0
//
// Import from other AI agents (Atomic parity): detect Claude Code, Codex,
// OpenCode, OpenClaw, Pi, and Hermes installations on this machine and import
// their skills, memory files, sessions, and bot configs into KriyaDot.
//
// Safety contract:
// - READ-ONLY on the source directories: detection and preview never write.
// - Secrets are redacted from imported content (never imported).
// - Imports are additive: existing KriyaDot skills/bots are never overwritten
//   (the API route skips name/id collisions and reports them).
// - All filesystem access goes through the injectable `ImportFs`, so tests
//   never touch the real home directory.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import matter from 'gray-matter';

/** Filesystem surface the importer needs. Injectable for tests. */
export interface ImportFs {
  exists(p: string): boolean;
  isDir(p: string): boolean;
  readDir(p: string): string[];
  readFile(p: string): string;
}

export const nodeImportFs: ImportFs = {
  exists: (p) => existsSync(p),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  readDir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  readFile: (p) => readFileSync(p, 'utf8'),
};

export type AgentSourceId = 'claude-code' | 'codex' | 'opencode' | 'openclaw' | 'pi' | 'hermes';

export interface SourceCounts {
  skills: number;
  sessions: number;
  memoryFiles: number;
  configs: number;
}

export interface SourceDetection {
  id: AgentSourceId;
  name: string;
  description: string;
  present: boolean;
  /** Where we looked. */
  locations: string[];
  counts: SourceCounts;
  note?: string;
}

export type ImportItemKind = 'skill' | 'memory' | 'session' | 'bot';

export interface ImportPreviewItem {
  /** Stable id used by the run endpoint, e.g. "skill:claude-code:pdf". */
  id: string;
  kind: ImportItemKind;
  title: string;
  detail: string;
  /** Short excerpt of what would be imported (redacted). */
  excerpt: string;
  /** Honest note when fidelity is lossy (e.g. sessions). */
  lossy?: string;
}

export interface BotProposal {
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  provider: string;
}

export interface ImportPreview {
  sourceId: AgentSourceId;
  sourceName: string;
  items: ImportPreviewItem[];
  botProposal?: BotProposal;
}

/** Raw parsed content the API route needs to execute an import. */
export interface ImportPayload {
  skills: Array<{ name: string; description: string; content: string }>;
  memories: Array<{ path: string; text: string; category: 'fact' | 'preference' }>;
  sessions: Array<{ id: string; title: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> }>;
  botProposal?: BotProposal;
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
  /\bsk-[A-Za-z0-9]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{10,}\b/g,
  /\bgho_[A-Za-z0-9]{10,}\b/g,
  /\bxox[bap]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  // key = value style secrets (case-insensitive keys)
  /\b(api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|pwd)\b\s*[:=]\s*("[^"]+"|'[^']+'|\S+)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/g,
];

/**
 * Redact secrets from imported text. Never throws: on any failure the whole
 * value is replaced with a placeholder so nothing sensitive can leak through.
 */
export function redactSecrets(text: string): string {
  try {
    let out = text;
    for (const re of SECRET_PATTERNS) {
      re.lastIndex = 0;
      out = out.replace(re, (m) => {
        // For key=value patterns keep the key name, redact the value.
        const kv = m.match(/^([A-Za-z0-9_.-]+\s*[:=]\s*)/);
        if (kv) return `${kv[1]}[REDACTED]`;
        if (/^Bearer\s/i.test(m)) return 'Bearer [REDACTED]';
        return '[REDACTED]';
      });
    }
    return out;
  } catch {
    return '[REDACTED: redaction failed]';
  }
}

/** Skill names become file names: lowercase kebab, safe chars only. */
export function sanitizeSkillName(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return clean || 'imported-skill';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Source-specific parsing
// ---------------------------------------------------------------------------

interface RawSkill {
  name: string;
  description: string;
  content: string;
}

function parseClaudeSkills(home: string, fs: ImportFs): RawSkill[] {
  const dir = join(home, '.claude', 'skills');
  if (!fs.isDir(dir)) return [];
  const out: RawSkill[] = [];
  for (const entry of fs.readDir(dir)) {
    const skillMd = join(dir, entry, 'SKILL.md');
    if (!fs.exists(skillMd) || fs.isDir(skillMd)) continue;
    try {
      const raw = fs.readFile(skillMd);
      const parsed = matter(raw);
      const name =
        typeof parsed.data?.name === 'string' && parsed.data.name.trim()
          ? parsed.data.name.trim()
          : entry;
      const description =
        typeof parsed.data?.description === 'string' && parsed.data.description.trim()
          ? parsed.data.description.trim()
          : `Imported from Claude Code skill "${entry}"`;
      out.push({ name: sanitizeSkillName(name), description: truncate(description, 300), content: raw });
    } catch {
      // Skip unreadable skills; reported as skipped by the caller.
    }
  }
  return out;
}

function findFilesRecursive(dir: string, fs: ImportFs, exts: string[], depth = 0, maxDepth = 4): string[] {
  if (depth > maxDepth || !fs.isDir(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readDir(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (fs.isDir(full)) {
      out.push(...findFilesRecursive(full, fs, exts, depth + 1, maxDepth));
    } else if (exts.some((e) => entry.toLowerCase().endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

/** Extract user/assistant text from a Claude Code session JSONL file. */
function parseClaudeSessionJsonl(text: string, maxMessages = 200): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const line of text.split('\n')) {
    if (messages.length >= maxMessages) break;
    const obj = safeJsonParse(line.trim()) as Record<string, unknown> | undefined;
    if (!obj || typeof obj !== 'object') continue;
    const type = obj.type as string | undefined;
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== 'object') continue;
    const role = message.role as string | undefined;
    if ((type === 'user' || type === 'assistant') && (role === 'user' || role === 'assistant')) {
      const textContent = extractTextContent(message.content);
      if (textContent.trim()) {
        messages.push({ role, content: truncate(textContent.trim(), 4000) });
      }
    }
  }
  return messages;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const block = b as Record<string, unknown>;
          if (block.type === 'text' && typeof block.text === 'string') return block.text;
          if (typeof block.text === 'string') return block.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseClaudeSessions(home: string, fs: ImportFs): Array<{ id: string; title: string; file: string }> {
  const projectsDir = join(home, '.claude', 'projects');
  if (!fs.isDir(projectsDir)) return [];
  const files = findFilesRecursive(projectsDir, fs, ['.jsonl'], 0, 3);
  return files.map((file) => ({
    id: `session:claude-code:${relative(home, file).replace(/[\\/]/g, '/')}`,
    title: basename(file, '.jsonl').slice(0, 80) || 'Claude Code session',
    file,
  }));
}

function parseClaudeMemoryFiles(home: string, fs: ImportFs): Array<{ path: string; rel: string }> {
  const out: Array<{ path: string; rel: string }> = [];
  const global = join(home, '.claude', 'CLAUDE.md');
  if (fs.exists(global) && !fs.isDir(global)) out.push({ path: global, rel: '.claude/CLAUDE.md' });
  const projectsDir = join(home, '.claude', 'projects');
  if (fs.isDir(projectsDir)) {
    for (const f of findFilesRecursive(projectsDir, fs, ['claude.md'], 0, 3)) {
      if (f !== global) out.push({ path: f, rel: relative(home, f).replace(/[\\/]/g, '/') });
    }
  }
  return out;
}

function parseClaudeBotProposal(home: string, fs: ImportFs): BotProposal | undefined {
  const cfgPath = join(home, '.claude.json');
  if (!fs.exists(cfgPath)) return undefined;
  const cfg = safeJsonParse(fs.readFile(cfgPath)) as Record<string, unknown> | undefined;
  if (!cfg || typeof cfg !== 'object') return undefined;
  const model = typeof cfg.model === 'string' ? cfg.model : 'claude-default';
  const customInstructions =
    typeof cfg.customInstructions === 'string' ? cfg.customInstructions : '';
  return {
    name: 'Claude Code Import',
    description: 'Bot pre-filled from your Claude Code configuration.',
    systemPrompt: customInstructions || 'You are a helpful coding assistant.',
    model: truncate(model, 120),
    provider: 'anthropic',
  };
}

/** Generic JSONL/JSON session scan for sources with a sessions dir. */
function parseGenericSessions(
  sessionsDir: string,
  sourceId: AgentSourceId,
  home: string,
  fs: ImportFs,
): Array<{ id: string; title: string; file: string }> {
  if (!fs.isDir(sessionsDir)) return [];
  const files = findFilesRecursive(sessionsDir, fs, ['.jsonl', '.json'], 0, 3);
  return files.slice(0, 50).map((file) => ({
    id: `session:${sourceId}:${relative(home, file).replace(/[\\/]/g, '/')}`,
    title: basename(file).replace(/\.(jsonl|json)$/i, '').slice(0, 80) || `${sourceId} session`,
    file,
  }));
}

/** Best-effort extraction of user/assistant turns from an unknown session JSON. */
function parseGenericSessionFile(text: string, maxMessages = 200): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const push = (role: 'user' | 'assistant', content: string) => {
    if (messages.length < maxMessages && content.trim()) {
      messages.push({ role, content: truncate(content.trim(), 4000) });
    }
  };
  // Try JSONL first.
  if (text.includes('\n')) {
    for (const line of text.split('\n')) {
      const obj = safeJsonParse(line.trim()) as Record<string, unknown> | undefined;
      if (!obj || typeof obj !== 'object') continue;
      const role = (obj.role as string) ?? (obj.message as Record<string, unknown> | undefined)?.role;
      const content = extractTextContent(
        (obj.content as unknown) ?? (obj.message as Record<string, unknown> | undefined)?.content ?? obj.text,
      );
      if (role === 'user' || role === 'assistant') push(role, content);
    }
    if (messages.length > 0) return messages;
  }
  // Try a single JSON doc with a messages/history/turns array.
  const doc = safeJsonParse(text) as Record<string, unknown> | undefined;
  if (doc && typeof doc === 'object') {
    const arr = (['messages', 'history', 'turns', 'conversation'] as const)
      .map((k) => doc[k])
      .find((v) => Array.isArray(v)) as Array<Record<string, unknown>> | undefined;
    if (arr) {
      for (const m of arr) {
        const role = m.role as string | undefined;
        if (role === 'user' || role === 'assistant') {
          push(role, extractTextContent(m.content ?? m.text ?? ''));
        }
      }
    }
  }
  return messages;
}

function parseOpenCodeCommands(home: string, fs: ImportFs): RawSkill[] {
  const dir = join(home, '.config', 'opencode', 'command');
  if (!fs.isDir(dir)) return [];
  const out: RawSkill[] = [];
  for (const entry of fs.readDir(dir)) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    const full = join(dir, entry);
    if (fs.isDir(full)) continue;
    try {
      const raw = fs.readFile(full);
      const parsed = matter(raw);
      const base = basename(entry, '.md');
      const description =
        typeof parsed.data?.description === 'string' && parsed.data.description.trim()
          ? parsed.data.description.trim()
          : `Imported from OpenCode command "${base}"`;
      out.push({
        name: sanitizeSkillName(base),
        description: truncate(description, 300),
        content: `---\nname: ${sanitizeSkillName(base)}\ndescription: ${truncate(description, 300)}\n---\n\n${parsed.content}`,
      });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

function parseOpenCodeBotProposal(home: string, fs: ImportFs): BotProposal | undefined {
  const cfgPath = join(home, '.config', 'opencode', 'opencode.json');
  if (!fs.exists(cfgPath)) return undefined;
  const cfg = safeJsonParse(fs.readFile(cfgPath)) as Record<string, unknown> | undefined;
  if (!cfg || typeof cfg !== 'object') return undefined;
  const model =
    typeof cfg.model === 'string'
      ? cfg.model
      : typeof (cfg as Record<string, unknown>).small_model === 'string'
        ? ((cfg as Record<string, unknown>).small_model as string)
        : 'opencode-default';
  const instructions = typeof cfg.instructions === 'string' ? cfg.instructions : '';
  return {
    name: 'OpenCode Import',
    description: 'Bot pre-filled from your OpenCode configuration.',
    systemPrompt: instructions || 'You are a helpful coding assistant.',
    model: truncate(model, 120),
    provider: 'opencode',
  };
}

// ---------------------------------------------------------------------------
// Source definitions
// ---------------------------------------------------------------------------

interface SourceDef {
  id: AgentSourceId;
  name: string;
  description: string;
  /** Directories we check for presence (relative to home). */
  locations: string[];
  note?: string;
}

const SOURCE_DEFS: SourceDef[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Skills, CLAUDE.md memory, session history, and config.',
    locations: ['.claude', '.claude.json'],
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'Session history and config.toml.',
    locations: ['.codex'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Custom commands, config, and model settings.',
    locations: [join('.config', 'opencode')],
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Config and workspace files (best-effort).',
    locations: ['.openclaw'],
    note: 'OpenClaw layouts vary by version; detection is best-effort.',
  },
  {
    id: 'pi',
    name: 'Pi',
    description: 'Config directory if present (best-effort).',
    locations: ['.pi'],
    note: 'Pi config location is not standardized; only ~/.pi is checked.',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    description: 'Config directory if present (best-effort).',
    locations: ['.hermes'],
    note: 'Hermes config location is not standardized; only ~/.hermes is checked.',
  },
];

/** Auto-detect which agent tools are installed. Read-only. */
export function detectAgentSources(homeDir: string, fs: ImportFs = nodeImportFs): SourceDetection[] {
  return SOURCE_DEFS.map((def) => {
    const locations = def.locations.map((l) => join(homeDir, l));
    const present = locations.some((p) => fs.exists(p));
    const counts: SourceCounts = { skills: 0, sessions: 0, memoryFiles: 0, configs: 0 };
    if (present) {
      try {
        switch (def.id) {
          case 'claude-code':
            counts.skills = parseClaudeSkills(homeDir, fs).length;
            counts.sessions = parseClaudeSessions(homeDir, fs).length;
            counts.memoryFiles = parseClaudeMemoryFiles(homeDir, fs).length;
            counts.configs = fs.exists(join(homeDir, '.claude.json')) ? 1 : 0;
            break;
          case 'codex':
            counts.sessions = parseGenericSessions(join(homeDir, '.codex', 'sessions'), def.id, homeDir, fs).length;
            counts.configs = fs.exists(join(homeDir, '.codex', 'config.toml')) ? 1 : 0;
            break;
          case 'opencode':
            counts.skills = parseOpenCodeCommands(homeDir, fs).length;
            counts.configs = fs.exists(join(homeDir, '.config', 'opencode', 'opencode.json')) ? 1 : 0;
            break;
          case 'openclaw':
            counts.configs = findFilesRecursive(join(homeDir, '.openclaw'), fs, ['.json'], 0, 2).length;
            break;
          case 'pi':
            counts.configs = findFilesRecursive(join(homeDir, '.pi'), fs, ['.json'], 0, 2).length;
            break;
          case 'hermes':
            counts.configs = findFilesRecursive(join(homeDir, '.hermes'), fs, ['.json'], 0, 2).length;
            break;
        }
      } catch {
        // Detection must never throw; counts stay at 0.
      }
    }
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      present,
      locations,
      counts,
      note: def.note,
    };
  });
}

/** Build a preview of what would be imported. Read-only. */
export function previewAgentImport(
  sourceId: AgentSourceId,
  homeDir: string,
  fs: ImportFs = nodeImportFs,
): ImportPreview {
  const def = SOURCE_DEFS.find((d) => d.id === sourceId);
  if (!def) throw new Error(`Unknown agent source: ${sourceId}`);
  const items: ImportPreviewItem[] = [];
  let botProposal: BotProposal | undefined;

  const pushSkill = (s: RawSkill) => {
    items.push({
      id: `skill:${sourceId}:${s.name}`,
      kind: 'skill',
      title: s.name,
      detail: s.description,
      excerpt: truncate(redactSecrets(s.content.replace(/^---[\s\S]*?---\s*/, '')), 500),
    });
  };

  if (sourceId === 'claude-code') {
    for (const s of parseClaudeSkills(homeDir, fs)) pushSkill(s);
    for (const m of parseClaudeMemoryFiles(homeDir, fs)) {
      let text = '';
      try {
        text = fs.readFile(m.path);
      } catch {
        continue;
      }
      items.push({
        id: `memory:${sourceId}:${m.rel}`,
        kind: 'memory',
        title: m.rel,
        detail: 'Memory/notes file → imported as durable bot memory (facts & preferences).',
        excerpt: truncate(redactSecrets(text), 500),
      });
    }
    for (const s of parseClaudeSessions(homeDir, fs).slice(0, 50)) {
      items.push({
        id: s.id,
        kind: 'session',
        title: s.title,
        detail: 'Session transcript → archived read-only conversation on the target bot.',
        excerpt: '',
        lossy:
          'Tool calls and attachments are not preserved; only user/assistant text turns are imported (max 200 turns).',
      });
    }
    botProposal = parseClaudeBotProposal(homeDir, fs);
  } else if (sourceId === 'codex') {
    for (const s of parseGenericSessions(join(homeDir, '.codex', 'sessions'), sourceId, homeDir, fs)) {
      items.push({
        id: s.id,
        kind: 'session',
        title: s.title,
        detail: 'Session transcript → archived read-only conversation on the target bot.',
        excerpt: '',
        lossy: 'Parsed best-effort from Codex session files; only user/assistant text turns (max 200).',
      });
    }
    if (fs.exists(join(homeDir, '.codex', 'config.toml'))) {
      let toml = '';
      try {
        toml = fs.readFile(join(homeDir, '.codex', 'config.toml'));
      } catch {
        toml = '';
      }
      if (toml) {
        items.push({
          id: `memory:${sourceId}:config.toml`,
          kind: 'memory',
          title: '.codex/config.toml',
          detail: 'Codex config → imported as bot memory (preferences). Secrets redacted.',
          excerpt: truncate(redactSecrets(toml), 500),
        });
      }
    }
  } else if (sourceId === 'opencode') {
    for (const s of parseOpenCodeCommands(homeDir, fs)) pushSkill(s);
    botProposal = parseOpenCodeBotProposal(homeDir, fs);
  } else {
    // openclaw / pi / hermes: best-effort — surface config JSON as memory.
    const base = join(homeDir, def.locations[0]);
    const files = findFilesRecursive(base, fs, ['.json', '.md'], 0, 2).slice(0, 20);
    for (const f of files) {
      let text = '';
      try {
        text = fs.readFile(f);
      } catch {
        continue;
      }
      const rel = relative(homeDir, f).replace(/[\\/]/g, '/');
      items.push({
        id: `memory:${sourceId}:${rel}`,
        kind: 'memory',
        title: rel,
        detail: `${def.name} file → imported as bot memory (best-effort). Secrets redacted.`,
        excerpt: truncate(redactSecrets(text), 500),
      });
    }
  }

  return { sourceId, sourceName: def.name, items: withBotItem(items, sourceId, botProposal, def.name), botProposal };
}

/** Append the bot-proposal as a selectable preview item when one exists. */
function withBotItem(
  items: ImportPreviewItem[],
  sourceId: AgentSourceId,
  botProposal: BotProposal | undefined,
  sourceName: string,
): ImportPreviewItem[] {
  if (!botProposal) return items;
  return [
    ...items,
    {
      id: `bot:${sourceId}`,
      kind: 'bot',
      title: `Create bot: ${botProposal.name}`,
      detail:
        `New bot pre-filled from your ${sourceName} config ` +
        `(model "${botProposal.model}", provider "${botProposal.provider}"). ` +
        'The bot id is derived from the name you choose; existing bots are never overwritten.',
      excerpt: truncate(redactSecrets(botProposal.systemPrompt), 500),
    },
  ];
}

/**
 * Load the full redacted payload for the selected item ids. Read-only on the
 * source; the caller writes to KriyaDot stores.
 */
export function loadImportPayload(
  sourceId: AgentSourceId,
  homeDir: string,
  itemIds: string[],
  fs: ImportFs = nodeImportFs,
): ImportPayload {
  const payload: ImportPayload = { skills: [], memories: [], sessions: [] };
  const wanted = new Set(itemIds);

  if (sourceId === 'claude-code') {
    for (const s of parseClaudeSkills(homeDir, fs)) {
      if (wanted.has(`skill:${sourceId}:${s.name}`)) {
        payload.skills.push({
          name: s.name,
          description: s.description,
          content: redactSecrets(s.content),
        });
      }
    }
    for (const m of parseClaudeMemoryFiles(homeDir, fs)) {
      if (wanted.has(`memory:${sourceId}:${m.rel}`)) {
        let text = '';
        try {
          text = fs.readFile(m.path);
        } catch {
          continue;
        }
        payload.memories.push({
          path: m.rel,
          text: redactSecrets(text).slice(0, 8000),
          category: /prefer|like|dislike|always|never/i.test(text.slice(0, 2000)) ? 'preference' : 'fact',
        });
      }
    }
    for (const s of parseClaudeSessions(homeDir, fs)) {
      if (wanted.has(s.id)) {
        let text = '';
        try {
          text = fs.readFile(s.file);
        } catch {
          continue;
        }
        const messages = parseClaudeSessionJsonl(text).map((m) => ({
          // HIGH fix: imported transcripts bypassed secret redaction — redact
          // every message before it is stored, same pass as live sessions.
          ...m,
          content: redactSecrets(m.content),
        }));
        payload.sessions.push({ id: s.id, title: s.title, messages });
      }
    }
    const proposal = parseClaudeBotProposal(homeDir, fs);
    if (proposal && wanted.has(`bot:${sourceId}`)) {
      payload.botProposal = {
        ...proposal,
        systemPrompt: redactSecrets(proposal.systemPrompt),
      };
    }
  } else if (sourceId === 'codex') {
    for (const s of parseGenericSessions(join(homeDir, '.codex', 'sessions'), sourceId, homeDir, fs)) {
      if (wanted.has(s.id)) {
        let text = '';
        try {
          text = fs.readFile(s.file);
        } catch {
          continue;
        }
        payload.sessions.push({
          id: s.id,
          title: s.title,
          // HIGH fix: imported transcripts bypassed secret redaction — redact
          // every message before it is stored, same pass as live sessions.
          messages: parseGenericSessionFile(text).map((m) => ({ ...m, content: redactSecrets(m.content) })),
        });
      }
    }
    if (wanted.has(`memory:${sourceId}:config.toml`)) {
      let toml = '';
      try {
        toml = fs.readFile(join(homeDir, '.codex', 'config.toml'));
      } catch {
        toml = '';
      }
      if (toml) payload.memories.push({ path: '.codex/config.toml', text: redactSecrets(toml).slice(0, 8000), category: 'preference' });
    }
  } else if (sourceId === 'opencode') {
    for (const s of parseOpenCodeCommands(homeDir, fs)) {
      if (wanted.has(`skill:${sourceId}:${s.name}`)) {
        payload.skills.push({ name: s.name, description: s.description, content: redactSecrets(s.content) });
      }
    }
    const proposal = parseOpenCodeBotProposal(homeDir, fs);
    if (proposal && wanted.has(`bot:${sourceId}`)) {
      payload.botProposal = { ...proposal, systemPrompt: redactSecrets(proposal.systemPrompt) };
    }
  } else {
    const def = SOURCE_DEFS.find((d) => d.id === sourceId);
    const base = join(homeDir, def?.locations[0] ?? '');
    for (const f of findFilesRecursive(base, fs, ['.json', '.md'], 0, 2)) {
      const rel = relative(homeDir, f).replace(/[\\/]/g, '/');
      if (wanted.has(`memory:${sourceId}:${rel}`)) {
        let text = '';
        try {
          text = fs.readFile(f);
        } catch {
          continue;
        }
        payload.memories.push({ path: rel, text: redactSecrets(text).slice(0, 8000), category: 'fact' });
      }
    }
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Grok bot export import (§1.7)
//
// A Grok bot export is a single config JSON (not a home directory), shaped
// roughly like:
//   {
//     "name": "Research Buddy",
//     "description": "...",                // optional
//     "instructions": "You are ...",       // or "persona" / "system_prompt"
//     "model": "grok-4",                   // or model_preferences.model /
//                                          // modelPreferences { model }
//     "temperature": 0.7,                  // model prefs we cannot map 1:1
//     "tools": [...], "knowledge": [...],  // Grok-side features: skipped
//     ...
//   }
// parseGrokBotExport maps name/instructions/model onto a BotProposal and
// reports every other top-level field as skipped (never silently dropped).
// ---------------------------------------------------------------------------

export interface GrokBotImportResult {
  botProposal: BotProposal;
  /** Top-level export fields that have no KriyaDot equivalent. */
  skippedFields: string[];
  /** Model-preference fields recognized but folded into notes, not config. */
  notedFields: string[];
}

const GROK_MAPPED_FIELDS = new Set([
  'name',
  'description',
  'instructions',
  'persona',
  'system_prompt',
  'systemPrompt',
  'model',
]);
const GROK_MODEL_PREF_CONTAINERS = ['model_preferences', 'modelPreferences', 'modelPrefs'] as const;
/** Model-pref keys we acknowledge in notedFields (provider/model are mapped when nested). */
const GROK_MODEL_PREF_KEYS = new Set([
  'model',
  'provider',
  'temperature',
  'top_p',
  'topP',
  'max_tokens',
  'maxTokens',
  'frequency_penalty',
  'presence_penalty',
]);

function grokString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Parse a Grok bot export (JSON text or an already-parsed object) into a
 * KriyaDot bot proposal. Throws on invalid JSON / non-object input / a
 * missing name. Secrets anywhere in the prompt text are redacted.
 */
export function parseGrokBotExport(input: string | unknown): GrokBotImportResult {
  let raw: unknown = input;
  if (typeof input === 'string') {
    raw = safeJsonParse(input);
    if (raw === undefined) throw new Error('Grok bot export is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Grok bot export must be a JSON object.');
  }
  const cfg = raw as Record<string, unknown>;
  const name = grokString(cfg.name);
  if (!name) throw new Error('Grok bot export has no "name".');

  const skippedFields: string[] = [];
  const notedFields: string[] = [];

  // Model prefs may be top-level or nested in a preferences container.
  let model = grokString(cfg.model);
  let provider = 'xai';
  for (const containerKey of GROK_MODEL_PREF_CONTAINERS) {
    const container = cfg[containerKey];
    if (container && typeof container === 'object' && !Array.isArray(container)) {
      const prefs = container as Record<string, unknown>;
      if (!model) model = grokString(prefs.model);
      const nestedProvider = grokString(prefs.provider);
      if (nestedProvider) provider = nestedProvider;
      for (const key of Object.keys(prefs)) {
        if (GROK_MODEL_PREF_KEYS.has(key) && key !== 'model' && key !== 'provider') {
          notedFields.push(`${containerKey}.${key}`);
        }
      }
    }
  }
  for (const key of ['temperature', 'top_p', 'topP', 'max_tokens', 'maxTokens']) {
    if (key in cfg) notedFields.push(key);
  }

  for (const key of Object.keys(cfg)) {
    if (GROK_MAPPED_FIELDS.has(key)) continue;
    if ((GROK_MODEL_PREF_CONTAINERS as readonly string[]).includes(key)) continue;
    if (notedFields.includes(key)) continue;
    skippedFields.push(key);
  }

  const instructions =
    grokString(cfg.instructions) ??
    grokString(cfg.persona) ??
    grokString(cfg.system_prompt) ??
    grokString(cfg.systemPrompt) ??
    'You are a helpful assistant.';

  return {
    botProposal: {
      name: truncate(name, 120),
      description:
        truncate(grokString(cfg.description) ?? 'Bot imported from a Grok bot export.', 500),
      systemPrompt: truncate(redactSecrets(instructions), 20_000),
      model: truncate(model ?? 'grok-4', 120),
      provider,
    },
    skippedFields: skippedFields.sort(),
    notedFields: notedFields.sort(),
  };
}

/** Preview-shaped wrapper so the import UI can show the Grok bot item + skipped fields. */
export function grokBotPreviewItem(result: GrokBotImportResult): ImportPreviewItem {
  const skipped = result.skippedFields.length
    ? ` Skipped (no KriyaDot equivalent): ${result.skippedFields.join(', ')}.`
    : '';
  const noted = result.notedFields.length
    ? ` Model preferences noted but not applied: ${result.notedFields.join(', ')}.`
    : '';
  return {
    id: 'bot:grok-bot',
    kind: 'bot',
    title: `Create bot: ${result.botProposal.name}`,
    detail:
      `New bot pre-filled from a Grok bot export (model "${result.botProposal.model}", ` +
      `provider "${result.botProposal.provider}").${skipped}${noted}`,
    excerpt: truncate(redactSecrets(result.botProposal.systemPrompt), 500),
    ...(result.skippedFields.length ? { lossy: `Fields skipped: ${result.skippedFields.join(', ')}` } : {}),
  };
}

/** Render a KriyaDot skill file (frontmatter format) from an imported skill. */
export function renderKriyaDotSkill(name: string, description: string, content: string): string {
  const body = content.replace(/^---[\s\S]*?---\s*/, '').trim();
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

export { SOURCE_DEFS };
