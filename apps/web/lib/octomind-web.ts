// SPDX-License-Identifier: Apache-2.0
/**
 * Pure logic for the Octomind-parity web surfaces (no React, no fetch):
 *  - #35/#37 reply quoting in the exact format the API's /reply produces
 *    (see apps/api/src/session-craft.ts `buildQuotedReply`),
 *  - #114/#135/#161/#164/#172/#175-#178 chat slash-command catalog,
 *    parsing, /copy segment selection and a generic result renderer model,
 *  - cloud (#cloud) Lightning status mapping — honest free-tier semantics,
 *  - free-LLM keyless lane labels,
 *  - #47 human-accounting normalization, #166 discovery grouping,
 *  - #143/#151 workflow file (JSON + TOML) serialize/parse + dry-run plan
 *    normalization.
 * Everything here is unit-tested in octomind-web.test.ts.
 */

// ---------------------------------------------------------------------------
// #35 / #37 — reply quoting
// ---------------------------------------------------------------------------

/** Excerpt cap used by the API's buildQuotedReply (session-craft.ts). */
export const QUOTE_EXCERPT_CHARS = 600;

/**
 * Marker prepended to a message that quotes only a *selection* of an
 * earlier message (#37). The API workstream can recognize a fragment
 * reply by this exact HTML-comment marker on the first line; the rest of
 * the message still follows the established whole-message quote format.
 */
export const QUOTED_FRAGMENT_MARKER = '<!-- quotedFragment -->';

export interface QuotableMessage {
  /** Ref as it should appear after '#': a server message id or a 1-based position. */
  ref: string;
  role: string;
  text: string;
}

export function quoteExcerpt(text: string): string {
  return text.length > QUOTE_EXCERPT_CHARS ? `${text.slice(0, QUOTE_EXCERPT_CHARS)}…` : text;
}

/** One message as a markdown blockquote (the API's quote block format). */
export function quoteBlock(text: string): string {
  return quoteExcerpt(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * Compose a point-by-point reply: one quote block per quoted message (in
 * the order given), then the user's response. With a single message this
 * is byte-identical in shape to the API's buildQuotedReply output:
 *   [Replying to message #<ref> (<role>)]\n> …\n\n<response>
 */
export function buildQuotedReply(quoted: QuotableMessage[], response: string): string {
  const blocks = quoted.map(
    (q) => `[Replying to message #${q.ref} (${q.role})]\n${quoteBlock(q.text)}`,
  );
  const body = response.trim();
  return body ? `${blocks.join('\n\n')}\n\n${body}` : blocks.join('\n\n');
}

/** True when a composed message carries the #37 fragment marker. */
export function hasQuotedFragmentMarker(text: string): boolean {
  return text.startsWith(QUOTED_FRAGMENT_MARKER);
}

/**
 * Compose a reply quoting ONLY the selected fragment of a message (#37).
 * Shape: marker line, then the established header + blockquote (with the
 * fragment, not the whole message), then the user's response.
 */
export function buildFragmentReply(
  source: { ref: string; role: string },
  fragment: string,
  response: string,
): string {
  const frag = fragment.trim();
  const header = `[Replying to a selection from message #${source.ref} (${source.role})]`;
  const body = response.trim();
  const quoted = `${QUOTED_FRAGMENT_MARKER}\n${header}\n${quoteBlock(frag)}`;
  return body ? `${quoted}\n\n${body}` : quoted;
}

// ---------------------------------------------------------------------------
// #114 et al. — chat slash commands
// ---------------------------------------------------------------------------

export type ChatCommandResultKind = 'card' | 'clipboard' | 'action';

export interface ChatCommandSpec {
  name: string;
  description: string;
  /** card → render the structured payload in chat; clipboard → copy text; action → side effect + card/notice. */
  resultKind: ChatCommandResultKind;
  argsHint?: string;
}

/** Built-in in-session commands added by the API workstream (Octomind parity). */
export const BUILTIN_CHAT_COMMANDS: ChatCommandSpec[] = [
  { name: 'share', description: 'Share this session as a public link', resultKind: 'action' },
  { name: 'analyze', description: 'Open the local session viewer (transcript, context, tokens/cost)', resultKind: 'card' },
  { name: 'copy', description: 'Copy a conversation segment to the clipboard', resultKind: 'clipboard', argsHint: 'last | assistant | user | all' },
  { name: 'done', description: 'Finish: compress context and kick off background learning', resultKind: 'action' },
  { name: 'info', description: 'Session tokens, cost, cache and compression in one view', resultKind: 'card' },
  { name: 'report', description: 'Per-request usage breakdown for this session', resultKind: 'card' },
  { name: 'usage', description: 'Usage and account balance for this session', resultKind: 'card' },
  { name: 'status', description: 'Live runs, monitors and background/shell jobs', resultKind: 'card' },
  { name: 'learning', description: 'What background learning has captured from this session', resultKind: 'card' },
  { name: 'schedule', description: 'Schedule a follow-up for this session', resultKind: 'card', argsHint: '<when> <text>' },
  { name: 'compact', description: 'Compact (compress) the session context now', resultKind: 'action' },
  { name: 'role', description: 'Switch this session’s role/persona mid-session', resultKind: 'action', argsHint: '<role>' },
  { name: 'skill', description: 'List or toggle skills for this session', resultKind: 'card', argsHint: '[list | on <id> | off <id>]' },
  { name: 'context', description: 'What this session’s history currently holds', resultKind: 'card' },
  { name: 'reply', description: 'Quote an earlier message point-by-point', resultKind: 'action', argsHint: '<#id|position> <text>' },
];

export function builtinCommand(name: string): ChatCommandSpec | undefined {
  return BUILTIN_CHAT_COMMANDS.find((c) => c.name === name);
}

export function isBuiltinCommand(name: string): boolean {
  return builtinCommand(name) !== undefined;
}

export interface ParsedSlashInvocation {
  name: string;
  args: string;
}

/** Parse a leading `/name args` invocation; null when the text is not one. */
export function parseSlashInvocation(text: string): ParsedSlashInvocation | null {
  const m = /^\/([a-z0-9-]{1,32})(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1]!, args: (m[2] ?? '').trim() };
}

// ---- /copy segment selection (#172) --------------------------------------

export interface CopyableMessage {
  role: string;
  text: string;
}

export type CopySegment = 'last' | 'assistant' | 'user' | 'all';

export function parseCopySegment(args: string): CopySegment {
  const a = args.trim().toLowerCase();
  if (a === 'assistant' || a === 'all-assistant') return 'assistant';
  if (a === 'user' || a === 'all-user') return 'user';
  if (a === 'all' || a === 'conversation' || a === 'whole') return 'all';
  return 'last';
}

/**
 * The text /copy puts on the clipboard for a segment. Mirrors the API's
 * segment selectors: last (message), assistant (all assistant messages),
 * user (all user messages), all (whole conversation, role-prefixed).
 */
export function selectCopySegment(
  messages: CopyableMessage[],
  args: string,
): { segment: CopySegment; text: string } {
  const segment = parseCopySegment(args);
  const usable = messages.filter((m) => m.text.trim().length > 0);
  if (segment === 'last') {
    const last = usable[usable.length - 1];
    return { segment, text: last ? last.text : '' };
  }
  if (segment === 'assistant' || segment === 'user') {
    return { segment, text: usable.filter((m) => m.role === segment).map((m) => m.text).join('\n\n') };
  }
  return { segment, text: usable.map((m) => `${m.role}: ${m.text}`).join('\n\n') };
}

// ---- Generic command-result rendering model -------------------------------

export interface CommandResultSection {
  title: string;
  lines: string[];
  /** Monospace block (JSON / long text) instead of lines, when present. */
  pre?: string;
}

function scalarLine(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `${key}: ${String(value)}`;
  }
  return null;
}

/**
 * Normalize ANY structured command payload into renderable sections, so a
 * command displays sanely before bespoke UI exists: scalars become lines,
 * arrays of scalars become lines, arrays/objects of objects become a
 * pretty-printed block, nested objects become their own sections.
 */
export function normalizeCommandResult(payload: unknown, fallbackTitle = 'Result'): CommandResultSection[] {
  if (payload === null || payload === undefined) return [{ title: fallbackTitle, lines: ['(no data)'] }];
  if (typeof payload === 'string') return [{ title: fallbackTitle, lines: payload.split('\n') }];
  if (typeof payload !== 'object') return [{ title: fallbackTitle, lines: [String(payload)] }];
  if (Array.isArray(payload)) {
    const scalar = payload.every((v) => v === null || typeof v !== 'object');
    return scalar
      ? [{ title: fallbackTitle, lines: payload.map((v) => String(v ?? '')) }]
      : [{ title: fallbackTitle, lines: [], pre: JSON.stringify(payload, null, 2) }];
  }
  const sections: CommandResultSection[] = [];
  const topLines: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (key === 'ok') continue;
    const line = scalarLine(key, value);
    if (line) {
      topLines.push(line);
      continue;
    }
    if (Array.isArray(value)) {
      const scalarArr = value.every((v) => v === null || typeof v !== 'object');
      sections.push(
        scalarArr
          ? { title: key, lines: value.map((v) => String(v ?? '')) }
          : { title: key, lines: [], pre: JSON.stringify(value, null, 2) },
      );
      continue;
    }
    if (value && typeof value === 'object') {
      const inner: string[] = [];
      let complex = false;
      for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) {
        const l2 = scalarLine(k2, v2);
        if (l2) inner.push(l2);
        else complex = true;
      }
      sections.push(
        complex || inner.length === 0
          ? { title: key, lines: inner, pre: JSON.stringify(value, null, 2) }
          : { title: key, lines: inner },
      );
      continue;
    }
    // null/undefined values are skipped.
  }
  return [{ title: fallbackTitle, lines: topLines }, ...sections].filter(
    (s) => s.lines.length > 0 || s.pre !== undefined || sections.length === 0,
  );
}

/** Plain-text rendering of a command payload (clipboard / fallback). */
export function commandResultToText(payload: unknown, title = 'Result'): string {
  return normalizeCommandResult(payload, title)
    .map((s) => [`## ${s.title}`, ...s.lines, ...(s.pre ? [s.pre] : [])].join('\n'))
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Cloud (Lightning) — status mapping with honest free-tier semantics
// ---------------------------------------------------------------------------

export type CloudUiState = 'disconnected' | 'connected' | 'running' | 'sleeping' | 'waking' | 'unknown';

export interface CloudStatusView {
  state: CloudUiState;
  label: string;
  connected: boolean;
  /** Public instance URL when the Studio reports one; never invented. */
  publicUrl: string | null;
  studioName: string | null;
  machine: string | null;
  tier: string | null;
  reachabilityNote: string | null;
}

const RUNNING_STATES = new Set(['running', 'on', 'started', 'ready', 'active']);
const SLEEPING_STATES = new Set(['sleeping', 'sleep', 'stopped', 'off', 'idle', 'paused']);
const WAKING_STATES = new Set(['waking', 'starting', 'pending', 'provisioning', 'resuming']);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Map a GET /api/cloud/lightning/status payload (either the brief's flat
 * shape or cloud-routes.ts's {connected, studio:{state,…}}) onto the UI
 * states: disconnected / connected / studio running / sleeping / waking.
 */
export function mapCloudStatus(raw: unknown): CloudStatusView {
  const root = asRecord(raw) ?? {};
  const studio = asRecord(root.studio);
  const connected = root.connected === true || studio !== null;
  const rawState = str(studio?.state) ?? str(studio?.rawStatus) ?? str(root.state) ?? str(root.status);
  const norm = rawState ? rawState.toLowerCase() : '';
  let state: CloudUiState;
  if (!connected) state = 'disconnected';
  else if (RUNNING_STATES.has(norm)) state = 'running';
  else if (SLEEPING_STATES.has(norm)) state = 'sleeping';
  else if (WAKING_STATES.has(norm)) state = 'waking';
  else if (studio || rawState) state = 'connected';
  else state = 'connected';
  const labels: Record<CloudUiState, string> = {
    disconnected: 'Disconnected',
    connected: 'Connected',
    running: 'Studio running',
    sleeping: 'Studio sleeping',
    waking: 'Studio waking…',
    unknown: 'Status unknown',
  };
  return {
    state,
    label: labels[state],
    connected,
    publicUrl:
      str(studio?.publicUrl) ?? str(studio?.url) ?? str(studio?.instanceUrl) ?? str(root.publicUrl) ?? str(root.instanceUrl),
    studioName: str(studio?.name) ?? str(root.studioName),
    machine: str(studio?.machine),
    tier: str(root.tier),
    reachabilityNote: str(root.reachabilityNote),
  };
}

/** Honest free-tier copy — "always reachable", never "always-on". */
export const CLOUD_FREE_TIER_NOTE =
  'Free tier: your Studio sleeps when idle and restarts about every 4 hours. It is always reachable (wake-on-traffic, ~1–2 min cold start) — it is not always-on. Uninterrupted always-on needs a paid Lightning plan.';

// ---------------------------------------------------------------------------
// Free-LLM keyless lanes
// ---------------------------------------------------------------------------

export interface KeylessLaneInfo {
  /** Short honest label shown next to the provider. */
  label: string;
  /** Limits / expectations note. */
  note: string;
  /** True when usable with NO api key at all. */
  keyless: boolean;
  /** True when the provider must only be offered as bring-your-own-key. */
  byokOnly?: boolean;
  /** True when the lane cannot do tool calls (plain chat only). */
  chatOnly?: boolean;
}

/**
 * Local fallback labels keyed by provider id, used when the provider
 * catalog does not (yet) expose `keyless` / `limitsNote` metadata.
 * Pollinations is deliberately NOT keyless here: it now requires a key.
 */
export const KEYLESS_LANE_FALLBACKS: Record<string, KeylessLaneInfo> = {
  ollama: {
    label: 'Private, on your machine — guaranteed',
    note: 'Runs locally via Ollama. No key, no shared limits.',
    keyless: true,
  },
  ovh: {
    label: 'Free shared lane — 2 requests/min per model, modest limits',
    note: 'OVHcloud AI Endpoints anonymous lane. Rotate models to spread the per-model limit.',
    keyless: true,
  },
  ovhcloud: {
    label: 'Free shared lane — 2 requests/min per model, modest limits',
    note: 'OVHcloud AI Endpoints anonymous lane. Rotate models to spread the per-model limit.',
    keyless: true,
  },
  llm7: {
    label: 'Free shared lane — best-effort',
    note: 'LLM7.io anonymous lane. Availability and limits vary; treat as best-effort.',
    keyless: true,
  },
  'ai-horde': {
    label: 'Free fallback — plain chat only, slow',
    note: 'AI Horde anonymous access. Plain chat only (no tool calls), queued and slow.',
    keyless: true,
    chatOnly: true,
  },
  horde: {
    label: 'Free fallback — plain chat only, slow',
    note: 'AI Horde anonymous access. Plain chat only (no tool calls), queued and slow.',
    keyless: true,
    chatOnly: true,
  },
  pollinations: {
    label: 'Bring your own key',
    note: 'Pollinations now requires your own key.',
    keyless: false,
    byokOnly: true,
  },
};

// Real catalog provider ids (agent-runtime providers/catalog.json) alias
// to the same honest labels.
KEYLESS_LANE_FALLBACKS['ovh-anonymous'] = KEYLESS_LANE_FALLBACKS.ovh!;
KEYLESS_LANE_FALLBACKS['llm7-anonymous'] = KEYLESS_LANE_FALLBACKS.llm7!;
KEYLESS_LANE_FALLBACKS.aihorde = KEYLESS_LANE_FALLBACKS['ai-horde']!;

/**
 * Resolve the lane info for a provider: catalog metadata (`keyless`,
 * `limitsNote`) wins when present; otherwise the local fallback table
 * keyed by provider id; local (on-machine) providers are keyless.
 */
export function keylessLaneFor(provider: {
  id: string;
  keyless?: boolean;
  limitsNote?: string;
  local?: boolean;
}): KeylessLaneInfo | null {
  const fallback = KEYLESS_LANE_FALLBACKS[provider.id.toLowerCase()];
  if (provider.keyless !== undefined || provider.limitsNote !== undefined) {
    return {
      label: fallback?.label ?? (provider.keyless ? 'Free — no key needed' : 'API key required'),
      note: provider.limitsNote ?? fallback?.note ?? '',
      keyless: provider.keyless ?? fallback?.keyless ?? false,
      ...(fallback?.byokOnly ? { byokOnly: true } : {}),
      ...(fallback?.chatOnly ? { chatOnly: true } : {}),
    };
  }
  if (fallback) return fallback;
  if (provider.local) {
    return { label: 'Private, on your machine — guaranteed', note: 'Runs locally. No key needed.', keyless: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// #47 — human time & energy accounting
// ---------------------------------------------------------------------------

export interface HumanAccountingView {
  requested: number;
  decided: number;
  approved: number;
  denied: number;
  pending: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  totalResponseSeconds: number | null;
  /**
   * Estimated time saved, in seconds — ONLY when the API provides it
   * (any of the known field spellings). The UI must not invent this
   * number; null renders as "not provided by the API yet".
   */
  estimatedTimeSavedSeconds: number | null;
  byBot: Array<{ botId: string; interventions: number; responseSeconds: number }>;
  bySession: Array<{ sessionId: string; interventions: number; responseSeconds: number; estimatedTimeSavedSeconds?: number }>;
  note: string | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Normalize either the global by-bot report or a per-session variant. */
export function normalizeHumanAccounting(raw: unknown): HumanAccountingView {
  const root = asRecord(raw) ?? {};
  const approvals = asRecord(root.approvals) ?? {};
  const human = asRecord(root.humanResponse) ?? asRecord(root.human_response) ?? {};
  const saved =
    num(root.estimatedTimeSavedSeconds) ??
    num(root.timeSavedSeconds) ??
    (num(root.estimatedTimeSavedMinutes) !== null ? num(root.estimatedTimeSavedMinutes)! * 60 : null) ??
    (num(root.estimatedTimeSavedHours) !== null ? num(root.estimatedTimeSavedHours)! * 3600 : null);
  const bySessionRaw = (root.bySession ?? root.sessions ?? asRecord(root.session)?.bySession) as unknown;
  const sessionRecord = asRecord(root.session);
  const bySession: HumanAccountingView['bySession'] = [];
  if (Array.isArray(bySessionRaw)) {
    for (const item of bySessionRaw) {
      const r = asRecord(item);
      if (r && str(r.sessionId)) {
        bySession.push({
          sessionId: str(r.sessionId)!,
          interventions: num(r.interventions) ?? num(r.requested) ?? 0,
          responseSeconds: num(r.responseSeconds) ?? num(r.totalSeconds) ?? 0,
          ...(num(r.estimatedTimeSavedSeconds) !== null
            ? { estimatedTimeSavedSeconds: num(r.estimatedTimeSavedSeconds)! }
            : {}),
        });
      }
    }
  } else if (sessionRecord && str(sessionRecord.sessionId)) {
    bySession.push({
      sessionId: str(sessionRecord.sessionId)!,
      interventions: num(sessionRecord.interventions) ?? num(approvals.requested) ?? 0,
      responseSeconds: num(sessionRecord.responseSeconds) ?? num(human.totalSeconds) ?? 0,
    });
  }
  const byBot: HumanAccountingView['byBot'] = [];
  if (Array.isArray(root.byBot)) {
    for (const item of root.byBot) {
      const r = asRecord(item);
      if (r && str(r.botId)) {
        byBot.push({
          botId: str(r.botId)!,
          interventions: num(r.interventions) ?? 0,
          responseSeconds: num(r.responseSeconds) ?? 0,
        });
      }
    }
  }
  return {
    requested: num(approvals.requested) ?? num(root.requested) ?? 0,
    decided: num(approvals.decided) ?? 0,
    approved: num(approvals.approved) ?? 0,
    denied: num(approvals.denied) ?? 0,
    pending: num(approvals.pending) ?? 0,
    medianSeconds: num(human.medianSeconds),
    p90Seconds: num(human.p90Seconds),
    totalResponseSeconds: num(human.totalSeconds),
    estimatedTimeSavedSeconds: saved,
    byBot,
    bySession,
    note: str(root.note),
  };
}

export function formatDurationSeconds(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return '—';
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ---------------------------------------------------------------------------
// #166 — intent discovery grouping
// ---------------------------------------------------------------------------

export type DiscoveryKind = 'bots' | 'skills' | 'capabilities' | 'mcp' | 'other';

export interface DiscoveryItem {
  id: string;
  kind: DiscoveryKind;
  name: string;
  description: string;
  score: number | null;
  raw: Record<string, unknown>;
}

const KIND_ALIASES: Record<string, DiscoveryKind> = {
  bot: 'bots', bots: 'bots',
  skill: 'skills', skills: 'skills',
  capability: 'capabilities', capabilities: 'capabilities', tool: 'capabilities', tools: 'capabilities',
  mcp: 'mcp', 'mcp-server': 'mcp', server: 'mcp', servers: 'mcp',
};

export function discoveryKindOf(rawKind: unknown): DiscoveryKind {
  if (typeof rawKind !== 'string') return 'other';
  return KIND_ALIASES[rawKind.toLowerCase()] ?? 'other';
}

/** Group a POST /api/discovery/search payload by kind (bots/skills/capabilities/mcp). */
export function groupDiscoveryResults(raw: unknown): Record<DiscoveryKind, DiscoveryItem[]> {
  const groups: Record<DiscoveryKind, DiscoveryItem[]> = { bots: [], skills: [], capabilities: [], mcp: [], other: [] };
  const root = asRecord(raw) ?? {};
  const push = (item: unknown, kindHint?: DiscoveryKind) => {
    const r = asRecord(item);
    if (!r) return;
    const kind = kindHint ?? discoveryKindOf(r.kind ?? r.type);
    groups[kind].push({
      id: str(r.id) ?? str(r.name) ?? `${kind}-${groups[kind].length}`,
      kind,
      name: str(r.name) ?? str(r.title) ?? str(r.id) ?? '(unnamed)',
      description: str(r.description) ?? str(r.summary) ?? '',
      score: num(r.score) ?? num(r.relevance),
      raw: r,
    });
  };
  if (Array.isArray(root.results)) for (const item of root.results) push(item);
  // Real API shape (discovery-routes.ts): { hits: [{ item: {kind,id,…}, score }] }.
  if (Array.isArray(root.hits)) {
    for (const hit of root.hits) {
      const hr = asRecord(hit);
      const item = asRecord(hr?.item);
      if (item) push({ ...item, score: hr?.score ?? item.score });
      else push(hit);
    }
  }
  for (const kind of ['bots', 'skills', 'capabilities', 'mcp'] as const) {
    if (Array.isArray(root[kind])) for (const item of root[kind] as unknown[]) push(item, kind);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// #143 / #151 — workflow files (JSON + TOML) and dry-run plans
// ---------------------------------------------------------------------------

export interface WorkflowFileDef {
  id: string;
  name: string;
  description?: string;
  nodes: Array<{ id: string; type: string; name: string; config: Record<string, unknown> }>;
  edges: unknown[];
  maxParallel?: number;
  budget?: { maxCostUsd: number };
}

/** Serialize a definition to the canonical kriyadot.workflow JSON envelope. */
export function serializeWorkflowJson(def: WorkflowFileDef): string {
  return JSON.stringify({ format: 'kriyadot.workflow', version: 1, workflow: def }, null, 2) + '\n';
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function tomlValue(value: unknown): string {
  if (value === null || value === undefined) {
    throw new Error('workflow TOML: null/undefined values cannot be represented; use the JSON format');
  }
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('workflow TOML: non-finite numbers cannot be represented');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)} = ${tomlValue(v)}`).join(', ')} }`;
  }
  throw new Error(`workflow TOML: unsupported value type ${typeof value}`);
}

/**
 * Serialize a definition to the TOML variant of the kriyadot.workflow v1
 * format (same layout as packages/workflows/src/toml-format.ts).
 */
export function serializeWorkflowToml(def: WorkflowFileDef): string {
  const lines: string[] = [
    '# KriyaDot workflow (TOML variant of the kriyadot.workflow v1 format)',
    'format = "kriyadot.workflow"',
    'version = 1',
    '',
    '[workflow]',
    `id = ${tomlString(def.id)}`,
    `name = ${tomlString(def.name)}`,
  ];
  if (def.description) lines.push(`description = ${tomlString(def.description)}`);
  if (typeof def.maxParallel === 'number') lines.push(`maxParallel = ${def.maxParallel}`);
  lines.push(`edges = ${tomlValue(def.edges)}`);
  const budget = asRecord(def.budget);
  if (budget && typeof budget.maxCostUsd === 'number') {
    lines.push('', '[workflow.budget]', `maxCostUsd = ${budget.maxCostUsd}`);
  }
  for (const node of def.nodes) {
    lines.push('', '[[workflow.nodes]]', `id = ${tomlString(node.id)}`, `type = ${tomlString(node.type)}`, `name = ${tomlString(node.name)}`, `config = ${tomlValue(node.config ?? {})}`);
  }
  return lines.join('\n') + '\n';
}

/** Detect a workflow file's format from its name and/or content. */
export function detectWorkflowFileKind(text: string, filename = ''): 'json' | 'toml' {
  if (/\.toml$/i.test(filename)) return 'toml';
  if (/\.json$/i.test(filename)) return 'json';
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'toml';
}

/** Parse + lightly validate a kriyadot.workflow JSON envelope; returns the definition. */
export function parseWorkflowJsonFile(text: string): WorkflowFileDef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`workflow file: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const root = asRecord(parsed);
  if (!root) throw new Error('workflow file: top level must be an object');
  // Accept both the envelope and a bare definition.
  const wf = root.format !== undefined ? asRecord(root.workflow) : root;
  if (root.format !== undefined && root.format !== 'kriyadot.workflow') {
    throw new Error(`workflow file: unsupported format "${String(root.format)}" (expected "kriyadot.workflow")`);
  }
  if (!wf || typeof wf.id !== 'string' || !Array.isArray(wf.nodes) || !Array.isArray(wf.edges)) {
    throw new Error('workflow file: workflow needs a string id, a nodes array and an edges array');
  }
  return wf as unknown as WorkflowFileDef;
}

// ---- Dry-run plan normalization (#151) ------------------------------------

export interface DryRunView {
  steps: Array<{ id: string; name: string; type?: string; detail?: string }>;
  estimatedCostUsd: number | null;
  errors: string[];
  warnings: string[];
  skipped: string[];
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    if (typeof x === 'string') return x;
    const r = asRecord(x);
    return str(r?.message) ?? str(r?.error) ?? JSON.stringify(x);
  });
}

/** Normalize a dry-run endpoint payload (plan levels, steps, or raw plan). */
export function normalizeDryRunPlan(raw: unknown): DryRunView {
  const root = asRecord(raw) ?? {};
  const plan = asRecord(root.plan) ?? root;
  const steps: DryRunView['steps'] = [];
  const pushNode = (n: unknown) => {
    const r = asRecord(n);
    if (!r) return;
    const step = asRecord(r.step);
    steps.push({
      id: str(r.id) ?? `step-${steps.length + 1}`,
      name: str(r.name) ?? str(r.id) ?? 'step',
      ...(str(r.type) ? { type: str(r.type)! } : {}),
      ...(step
        ? {
            detail: Object.entries(step)
              .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
              .join(' · '),
          }
        : {}),
    });
  };
  if (Array.isArray(plan.levels)) {
    for (const level of plan.levels) {
      const lr = asRecord(level);
      if (lr && Array.isArray(lr.nodes)) for (const n of lr.nodes) pushNode(n);
    }
  }
  if (Array.isArray(plan.steps)) for (const s of plan.steps) pushNode(s);
  if (Array.isArray(plan.nodes)) for (const n of plan.nodes) pushNode(n);
  const budget = asRecord(plan.budget);
  return {
    steps,
    estimatedCostUsd:
      num(root.estimatedCostUsd) ?? num(plan.estimatedCostUsd) ?? num(root.estimatedCost) ?? num(budget?.maxCostUsd),
    errors: [...stringList(root.errors), ...stringList(root.validationErrors), ...stringList(plan.errors)],
    warnings: [...stringList(root.warnings), ...stringList(plan.warnings)],
    skipped: Array.isArray(plan.skipped) ? plan.skipped.map((s) => String(s)) : [],
  };
}
