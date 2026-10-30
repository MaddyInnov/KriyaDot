// SPDX-License-Identifier: Apache-2.0
// Memory import finishes (Muse parity audit §4.4: MEM-6 / MEM-7).
//
// MEM-6 — Guided paste-import. Muse's flow is prompt-out / markdown-in:
// the user pastes a prompt into their OTHER assistant, pastes the
// markdown it answers with back here, and the facts become memory.
//   - MEMORY_EXPORT_PROMPT: the exact prompt to copy out.
//   - parseMemoryMarkdown(): tolerant parser for the answer — bullets,
//     numbered lists, plain paragraphs, optional trailing
//     "(confidence: 0.9)" markers, markdown emphasis/links stripped.
//   - importPasteMarkdown(): stores parsed facts as atoms via the tiered
//     store (which dedupes), sourceTurn 'paste-import'.
//
// MEM-7 — Consumer ZIP chat-export intake. Reuses the zip-safe intake
// from file-intake.ts (Slice 1): isZipArchive + listZipEntries for the
// caps, extractZipToWorkspace for traversal-safe extraction — there is
// deliberately NO second unzip path here. Extracted conversations are
// normalised from the shapes real consumer exports use:
//   - ChatGPT conversations.json ({ title, mapping: { id: { message:
//     { author: { role }, content: { parts } } } } })
//   - Claude conversations.json ([{ name, chat_messages: [{ sender,
//     text | content }] }])
//   - JSONL transcripts ({ role, content | text } per line)
//   - plain .txt/.md transcripts ("User: …" / "Assistant: …" lines)
// Each conversation is summarised into ONE memory atom (category
// 'summary', sourceTurn 'zip-import:<file>'). The summariser is an
// injected seam: production wires a local model, tests inject a mock —
// zero paid API use either way. Without a summariser, an explicitly
// labeled extractive fallback runs (opening user turns, condensed).

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TieredMemoryStore } from '@mvp/agent-runtime';
import { extractZipToWorkspace, isZipArchive, listZipEntries } from './file-intake.js';

// ---------------------------------------------------------------------------
// MEM-6: prompt-out / markdown-in
// ---------------------------------------------------------------------------

export const MEMORY_EXPORT_PROMPT = [
  'Please export what you remember about me as markdown.',
  '',
  'Rules:',
  '- Output ONLY a markdown bullet list (lines starting with "- ").',
  '- One durable fact per bullet: preferences, names, projects, decisions,',
  '  important dates, people and how they relate to me, working style.',
  '- No chat transcript, no explanations, no headings.',
  '- If you are unsure about a fact, append "(confidence: 0.5)" to its line;',
  '  leave confident facts unmarked.',
  '- At most 100 bullets.',
].join('\n');

export interface ParsedMemoryFact {
  fact: string;
  confidence: number;
}

const CONFIDENCE_RE = /\(\s*confidence\s*:\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*\)\s*$/i;

function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/** Parse the markdown answer from the paste-import flow into facts. */
export function parseMemoryMarkdown(markdown: string): ParsedMemoryFact[] {
  const facts: ParsedMemoryFact[] = [];
  const seen = new Set<string>();
  for (const rawLine of (markdown ?? '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue; // headings are structure, not facts
    if (/^<!--/.test(line) || /^---+$/.test(line)) continue;
    line = line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^\[[ xX]\]\s+/, '');
    let confidence = 0.8;
    const m = CONFIDENCE_RE.exec(line);
    if (m) {
      confidence = Number(m[1]);
      line = line.slice(0, m.index).trim();
    }
    line = stripMarkdown(line.replace(/^fact\s*:\s*/i, ''));
    if (line.length < 3 || line.length > 1000) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ fact: line, confidence });
    if (facts.length >= 100) break;
  }
  return facts;
}

export interface PasteImportResult {
  parsed: number;
  storedAtomIds: string[];
  /** Facts the store deduped against existing memory. */
  deduped: number;
}

export function importPasteMarkdown(
  memory: TieredMemoryStore,
  botId: string,
  markdown: string,
): PasteImportResult {
  const parsed = parseMemoryMarkdown(markdown);
  const before = new Set(memory.getAtoms(botId, 5000, { includeInactive: true }).map((a) => a.id));
  const storedAtomIds: string[] = [];
  let deduped = 0;
  for (const f of parsed) {
    const id = memory.storeAtom(botId, { fact: f.fact, entities: [], confidence: f.confidence }, 'paste-import');
    if (before.has(id)) deduped += 1;
    else { storedAtomIds.push(id); before.add(id); }
  }
  return { parsed: parsed.length, storedAtomIds, deduped };
}

// ---------------------------------------------------------------------------
// MEM-7: consumer ZIP chat-export intake
// ---------------------------------------------------------------------------

export interface ExportTurn {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export interface ExportConversation {
  title: string;
  sourceFile: string;
  format: 'chatgpt' | 'claude' | 'jsonl' | 'transcript';
  turns: ExportTurn[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function textOfParts(parts: unknown): string {
  if (typeof parts === 'string') return parts;
  if (Array.isArray(parts)) {
    return parts
      .map((p) => (typeof p === 'string' ? p : (asRecord(p)?.text as string) ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseChatGptConversation(item: Record<string, unknown>, sourceFile: string): ExportConversation | null {
  const mapping = asRecord(item.mapping);
  if (!mapping) return null;
  const turns: ExportTurn[] = [];
  for (const node of Object.values(mapping)) {
    const message = asRecord(asRecord(node)?.message);
    if (!message) continue;
    const role = asRecord(message.author)?.role;
    const text = textOfParts(asRecord(message.content)?.parts).trim();
    if (!text) continue;
    if (role === 'user' || role === 'assistant' || role === 'system') turns.push({ role, text });
  }
  if (turns.length === 0) return null;
  return { title: String(item.title ?? 'Untitled conversation'), sourceFile, format: 'chatgpt', turns };
}

function parseClaudeConversation(item: Record<string, unknown>, sourceFile: string): ExportConversation | null {
  const messages = item.chat_messages;
  if (!Array.isArray(messages)) return null;
  const turns: ExportTurn[] = [];
  for (const raw of messages) {
    const msg = asRecord(raw);
    if (!msg) continue;
    const sender = msg.sender === 'human' ? 'user' : msg.sender === 'assistant' ? 'assistant' : null;
    if (!sender) continue;
    const text = (typeof msg.text === 'string' ? msg.text : textOfParts(msg.content)).trim();
    if (text) turns.push({ role: sender, text });
  }
  if (turns.length === 0) return null;
  return { title: String(item.name ?? 'Untitled conversation'), sourceFile, format: 'claude', turns };
}

/** Parse one extracted export file into conversations (empty when unrecognised). */
export function parseChatExportFile(fileName: string, content: string): ExportConversation[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) {
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return []; }
    const items = Array.isArray(parsed) ? parsed : Array.isArray(asRecord(parsed)?.conversations) ? (asRecord(parsed)!.conversations as unknown[]) : [parsed];
    const out: ExportConversation[] = [];
    for (const raw of items) {
      const item = asRecord(raw);
      if (!item) continue;
      const conv = parseChatGptConversation(item, fileName) ?? parseClaudeConversation(item, fileName);
      if (conv) out.push(conv);
    }
    return out;
  }
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) {
    const turns: ExportTurn[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = asRecord(JSON.parse(line));
        const role = rec?.role;
        const text = (typeof rec?.content === 'string' ? rec.content : typeof rec?.text === 'string' ? rec.text : '').trim();
        if ((role === 'user' || role === 'assistant' || role === 'system') && text) turns.push({ role, text });
      } catch { /* skip malformed lines */ }
    }
    return turns.length ? [{ title: fileName, sourceFile: fileName, format: 'jsonl', turns }] : [];
  }
  if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    const turns: ExportTurn[] = [];
    let current: ExportTurn | null = null;
    for (const line of content.split(/\r?\n/)) {
      const m = /^(user|assistant|human|me|system)\s*:\s*(.*)$/i.exec(line.trim());
      if (m) {
        if (current) turns.push(current);
        const raw = m[1]!.toLowerCase();
        current = { role: raw === 'human' || raw === 'me' ? 'user' : (raw as ExportTurn['role']), text: m[2] ?? '' };
      } else if (current && line.trim()) {
        current.text += `\n${line.trim()}`;
      }
    }
    if (current) turns.push(current);
    const cleaned = turns.map((t) => ({ ...t, text: t.text.trim() })).filter((t) => t.text);
    return cleaned.length ? [{ title: fileName, sourceFile: fileName, format: 'transcript', turns: cleaned }] : [];
  }
  return [];
}

export type ChatExportSummarizer = (prompt: string) => Promise<string>;

export function buildConversationSummaryPrompt(conv: ExportConversation): string {
  const transcript = conv.turns
    .map((t) => `${t.role === 'user' ? 'User' : t.role === 'assistant' ? 'Assistant' : 'System'}: ${t.text}`)
    .join('\n')
    .slice(0, 12000);
  return [
    `Summarise this exported conversation ("${conv.title}") into durable memory about the USER.`,
    'Write 1-3 sentences of facts worth remembering (preferences, projects, decisions, people).',
    'Facts only — no transcript, no commentary about the conversation itself.',
    '',
    transcript,
  ].join('\n');
}

/** Extractive fallback — explicitly labeled; opening substantive user turns, condensed. */
export function extractiveConversationSummary(conv: ExportConversation): string {
  const userTurns = conv.turns
    .filter((t) => t.role === 'user')
    .map((t) => t.text.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 20)
    .slice(0, 3);
  const body = userTurns.length > 0 ? userTurns.join(' ') : conv.turns.slice(0, 2).map((t) => t.text.replace(/\s+/g, ' ').trim()).join(' ');
  return `Extractive summary of exported conversation "${conv.title}" (no summarizer configured; condensed from the user's own turns, not model-generated): ${body}`.slice(0, 950);
}

export interface ZipImportResult {
  filesSeen: string[];
  conversations: number;
  storedAtomIds: string[];
  summaries: Array<{ conversationTitle: string; sourceFile: string; kind: 'generated' | 'extractive'; atomId: string }>;
}

/**
 * Import a consumer chat-export ZIP into memory. Extraction goes through
 * file-intake's extractZipToWorkspace into a scratch subdir under
 * `workRoot`, which is removed afterwards (success or failure).
 */
export async function importChatExportZip(
  memory: TieredMemoryStore,
  botId: string,
  data: Uint8Array,
  opts: { workRoot: string; summarizer?: ChatExportSummarizer },
): Promise<ZipImportResult> {
  if (!isZipArchive(data)) throw new Error('payload is not a zip archive');
  const filesSeen = listZipEntries(data).filter((e) => !e.isDir).map((e) => e.name);
  const stamp = `import-${Date.now().toString(36)}`;
  // file-intake's confinement resolves real paths — the root must exist.
  mkdirSync(opts.workRoot, { recursive: true });
  const extracted = extractZipToWorkspace(data, opts.workRoot, { subdir: stamp });
  try {
    const conversations: ExportConversation[] = [];
    for (const rel of extracted.extracted) {
      const abs = join(opts.workRoot, rel);
      if (!existsSync(abs)) continue;
      const name = rel.split('/').pop() ?? rel;
      if (!/\.(json|jsonl|ndjson|txt|md)$/i.test(name)) continue;
      conversations.push(...parseChatExportFile(name, readFileSync(abs, 'utf8')));
    }
    const storedAtomIds: string[] = [];
    const summaries: ZipImportResult['summaries'] = [];
    for (const conv of conversations.slice(0, 50)) {
      let summary: string | null = null;
      let kind: 'generated' | 'extractive' = 'extractive';
      if (opts.summarizer) {
        try {
          const out = (await opts.summarizer(buildConversationSummaryPrompt(conv))).trim();
          if (out) { summary = out; kind = 'generated'; }
        } catch { summary = null; }
      }
      if (!summary) summary = extractiveConversationSummary(conv);
      const atomId = memory.storeAtom(
        botId,
        { fact: summary.slice(0, 950), entities: [], confidence: kind === 'generated' ? 0.75 : 0.6 },
        `zip-import:${conv.sourceFile}`,
        undefined,
        { category: 'summary' },
      );
      storedAtomIds.push(atomId);
      summaries.push({ conversationTitle: conv.title, sourceFile: conv.sourceFile, kind, atomId });
    }
    return { filesSeen, conversations: conversations.length, storedAtomIds, summaries };
  } finally {
    rmSync(join(opts.workRoot, stamp), { recursive: true, force: true });
  }
}
