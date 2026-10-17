// SPDX-License-Identifier: Apache-2.0
/**
 * Markdown team-spec format (original KriyaDot format, "BotMRR parity").
 *
 * A team is described as a single human-readable Markdown document that can
 * be pasted into the Teams page, stored in git, or shared. The API parses it
 * (POST /api/teams/import-markdown) and can serialize a team back out
 * (GET /api/teams/:id/export-markdown) — the round trip is lossless for
 * everything the format covers.
 *
 * Format:
 *
 *   # Team: Research Squad
 *   > A crack team for deep research tasks.
 *
 *   ## Members
 *   - **Scout** (role: coordinator) — searches the web broadly
 *     - bot: scout
 *     - persona: You are a research coordinator. Break work down, delegate, synthesize.
 *     - tools: web_search, fetch_page
 *   - **Writer** (role: member)
 *     - bot: writer
 *
 *   ## Roster prompt
 *   You coordinate the Research Squad. Delegate subtasks with the `delegate`
 *   tool and synthesize the final answer.
 *
 *   ## Coordination rules
 *   - delegation: always-ask
 *   - writer: always-allow
 *
 * Rules:
 * - The `#` heading names the team. The "Team:" prefix is optional; the
 *   rest of the line is the team name (max 120 chars).
 * - A `>` blockquote directly under the heading is the team description.
 * - `## Members` lists one `- **Name**` bullet per member. `(role:
 *   coordinator|member)` marks the coordinator (default: member). Sub-keys
 *   under a member bullet: `bot:` (bot id — matched against known bots, or
 *   by name case-insensitively), `persona:` (system-prompt snippet stored on
 *   the member for display), `tools:` (comma-separated tool names, display
 *   only). Text after the `—`/`-` on the bullet line is a free-form note.
 * - `## Roster prompt` (also `## Roster` / `## Prompt`) holds the
 *   coordinator's roster prompt verbatim.
 * - `## Coordination rules` (also `## Rules`) holds `- delegation:
 *   <policy>` for the default delegation policy plus `- <botId>: <policy>`
 *   per-bot overrides. Policies: always-allow | approve-once-per-team |
 *   always-ask.
 * - Unknown sections are ignored (forward-compatible). Lines that don't
 *   parse are ignored, never fatal — except a missing team name or zero
 *   members, which are validation errors.
 *
 * The parser is deliberately hand-written (no markdown dependency): the
 * format is a strict subset, and a dependency would be overkill.
 */

export type MarkdownMemberRole = 'coordinator' | 'member';
export type DelegationPolicyName = 'always-allow' | 'approve-once-per-team' | 'always-ask';

export const MARKDOWN_DELEGATION_POLICIES: readonly DelegationPolicyName[] = [
  'always-allow',
  'approve-once-per-team',
  'always-ask',
];

export interface MarkdownTeamMember {
  /** Display name from the `**Name**` bullet. */
  name: string;
  role: MarkdownMemberRole;
  /** Bot id referenced by `bot:` (may be a name; resolved by the importer). */
  botRef?: string;
  persona?: string;
  tools?: string[];
  note?: string;
}

export interface MarkdownTeamSpec {
  name: string;
  description?: string;
  members: MarkdownTeamMember[];
  /** The coordinator is members.find(m => m.role === 'coordinator'). */
  rosterPrompt?: string;
  coordinationRules: {
    delegationPolicy?: DelegationPolicyName;
    overrides?: Record<string, DelegationPolicyName>;
  };
}

export interface ParseIssue {
  line: number;
  message: string;
}

export interface ParseResult {
  ok: boolean;
  spec?: MarkdownTeamSpec;
  issues: ParseIssue[];
}

function isDelegationPolicyName(v: string): v is DelegationPolicyName {
  return (MARKDOWN_DELEGATION_POLICIES as readonly string[]).includes(v);
}

function cleanLine(s: string): string {
  return s.replace(/\s+$/, '');
}

/**
 * Parse a markdown team-spec document. Never throws on malformed input —
 * returns { ok: false, issues } instead. ok requires a team name and at
 * least one member.
 */
export function parseTeamMarkdown(markdown: string): ParseResult {
  const issues: ParseIssue[] = [];
  const lines = markdown.split('\n').map(cleanLine);
  const spec: MarkdownTeamSpec = {
    name: '',
    members: [],
    coordinationRules: {},
  };

  type Section = 'none' | 'members' | 'roster' | 'rules' | 'ignored';
  let section: Section = 'none';
  let rosterLines: string[] = [];
  let currentMember: MarkdownTeamMember | null = null;
  let seenTitle = false;

  const flushMember = (): void => {
    if (currentMember) {
      spec.members.push(currentMember);
      currentMember = null;
    }
  };
  const flushRoster = (): void => {
    if (section === 'roster') {
      const text = rosterLines.join('\n').trim();
      if (text) spec.rosterPrompt = text;
      rosterLines = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();

    // Headings.
    const h1 = /^#\s+(.+)$/.exec(trimmed);
    if (h1 && !seenTitle) {
      seenTitle = true;
      flushMember();
      flushRoster();
      const raw = h1[1].trim().replace(/^Team:\s*/i, '').trim();
      spec.name = raw.slice(0, 120);
      if (!spec.name) issues.push({ line: lineNo, message: 'Team name is empty.' });
      section = 'none';
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(trimmed);
    if (h2) {
      flushMember();
      flushRoster();
      const title = h2[1].trim().toLowerCase();
      if (title === 'members') section = 'members';
      else if (title === 'roster prompt' || title === 'roster' || title === 'prompt') section = 'roster';
      else if (title === 'coordination rules' || title === 'rules') section = 'rules';
      else section = 'ignored';
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      // Other headings: end current structured section.
      flushMember();
      flushRoster();
      section = 'ignored';
      continue;
    }

    if (!seenTitle) {
      if (trimmed) issues.push({ line: lineNo, message: 'Content before the team heading is ignored.' });
      continue;
    }

    // Description blockquote directly under the title.
    if (section === 'none' && trimmed.startsWith('>')) {
      const text = trimmed.replace(/^>\s?/, '');
      spec.description = spec.description ? `${spec.description}\n${text}` : text;
      continue;
    }

    if (section === 'members') {
      // Member bullet: - **Name** (role: coordinator) — note
      const bullet = /^[-*]\s+\*\*(.+?)\*\*\s*(.*)$/.exec(trimmed);
      if (bullet) {
        flushMember();
        const name = bullet[1].trim();
        const rest = bullet[2].trim();
        let role: MarkdownMemberRole = 'member';
        const roleMatch = /\(role:\s*(coordinator|member)\)/i.exec(rest);
        if (roleMatch) role = roleMatch[1].toLowerCase() as MarkdownMemberRole;
        let note: string | undefined;
        const noteMatch = /(?:—|–|-)\s*(.+)$/.exec(rest.replace(/\(role:\s*(coordinator|member)\)/i, '').trim());
        if (noteMatch) note = noteMatch[1].trim();
        if (!name) {
          issues.push({ line: lineNo, message: 'Member bullet has an empty name — skipped.' });
          continue;
        }
        currentMember = { name: name.slice(0, 120), role, ...(note ? { note: note.slice(0, 500) } : {}) };
        continue;
      }
      // Sub-key: indented "- key: value"
      const sub = /^\s*[-*]\s+([A-Za-z]+):\s*(.+)$/.exec(line);
      if (sub && currentMember) {
        const key = sub[1].toLowerCase();
        const value = sub[2].trim();
        if (key === 'bot') currentMember.botRef = value.slice(0, 200);
        else if (key === 'persona') currentMember.persona = value.slice(0, 4000);
        else if (key === 'role' && (value === 'coordinator' || value === 'member')) {
          currentMember.role = value;
        } else if (key === 'tools') {
          currentMember.tools = value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 50);
        } else {
          issues.push({ line: lineNo, message: `Unknown member sub-key "${key}" — ignored.` });
        }
        continue;
      }
      if (trimmed) issues.push({ line: lineNo, message: 'Unrecognized line in Members — ignored.' });
      continue;
    }

    if (section === 'roster') {
      rosterLines.push(line);
      continue;
    }

    if (section === 'rules') {
      const rule = /^[-*]\s+([A-Za-z0-9_.-]+):\s*(.+)$/.exec(trimmed);
      if (rule) {
        const key = rule[1].trim();
        const value = rule[2].trim().toLowerCase();
        if (!isDelegationPolicyName(value)) {
          issues.push({
            line: lineNo,
            message: `Unknown delegation policy "${rule[2].trim()}" — expected one of ${MARKDOWN_DELEGATION_POLICIES.join(', ')}.`,
          });
          continue;
        }
        if (key.toLowerCase() === 'delegation') {
          spec.coordinationRules.delegationPolicy = value;
        } else {
          spec.coordinationRules.overrides = spec.coordinationRules.overrides ?? {};
          spec.coordinationRules.overrides[key] = value;
        }
        continue;
      }
      if (trimmed) issues.push({ line: lineNo, message: 'Unrecognized line in Coordination rules — ignored.' });
      continue;
    }
    // section 'none' / 'ignored': skip quietly.
  }
  flushMember();
  flushRoster();

  if (!spec.name) {
    return { ok: false, issues: [...issues, { line: 0, message: 'No team heading found (expected "# Team: <name>").' }] };
  }
  if (spec.members.length === 0) {
    return { ok: false, issues: [...issues, { line: 0, message: 'No members found (expected a "## Members" section with "- **Name**" bullets).' }] };
  }
  const coordinators = spec.members.filter((m) => m.role === 'coordinator');
  if (coordinators.length > 1) {
    issues.push({
      line: 0,
      message: `Multiple coordinators (${coordinators.map((c) => c.name).join(', ')}) — the first is used as coordinator.`,
    });
  }
  return { ok: true, spec, issues };
}

export interface ResolvedMarkdownMember extends MarkdownTeamMember {
  /** Resolved bot id (after matching botRef against known bots). */
  botId: string;
}

export interface ResolveBots {
  id: string;
  name: string;
}

/**
 * Resolve each member's `bot:` reference against known bots: exact id
 * first, then case-insensitive id, then case-insensitive name. Throws
 * listing every unresolvable reference.
 */
export function resolveMarkdownBots(spec: MarkdownTeamSpec, bots: ResolveBots[]): ResolvedMarkdownMember[] {
  const byId = new Map(bots.map((b) => [b.id, b]));
  const byLowerId = new Map(bots.map((b) => [b.id.toLowerCase(), b]));
  const byLowerName = new Map(bots.map((b) => [b.name.toLowerCase(), b]));
  const missing: string[] = [];
  const resolved = spec.members.map((m) => {
    const ref = (m.botRef ?? m.name).trim();
    const hit = byId.get(ref) ?? byLowerId.get(ref.toLowerCase()) ?? byLowerName.get(ref.toLowerCase());
    if (!hit) {
      missing.push(`"${m.name}" → "${ref}"`);
      return { ...m, botId: '' };
    }
    return { ...m, botId: hit.id };
  });
  if (missing.length > 0) {
    const known = bots.map((b) => b.id).join(', ') || '(no bots configured)';
    throw new Error(`Unknown bots: ${missing.join('; ')}. Known bot ids: ${known}`);
  }
  return resolved as ResolvedMarkdownMember[];
}

export interface SerializableTeam {
  name: string;
  description?: string;
  coordinatorBotId: string;
  memberBotIds: string[];
  delegationPolicy?: string;
  delegationPolicyOverrides?: Record<string, string>;
  rosterPrompt?: string;
}

export interface SerializableBot {
  id: string;
  name: string;
  persona?: string;
}

/** Serialize a team back to the markdown spec format (round-trip). */
export function serializeTeamMarkdown(team: SerializableTeam, bots: SerializableBot[]): string {
  const byId = new Map(bots.map((b) => [b.id, b]));
  const out: string[] = [];
  out.push(`# Team: ${team.name}`);
  if (team.description) {
    for (const dl of team.description.split('\n')) out.push(`> ${dl}`);
  }
  out.push('', '## Members');
  const memberIds = [team.coordinatorBotId, ...team.memberBotIds.filter((id) => id !== team.coordinatorBotId)];
  for (const id of memberIds) {
    const bot = byId.get(id);
    const name = bot?.name ?? id;
    const role = id === team.coordinatorBotId ? 'coordinator' : 'member';
    out.push(`- **${name}** (role: ${role})`);
    out.push(`  - bot: ${id}`);
    if (bot?.persona) out.push(`  - persona: ${bot.persona}`);
  }
  if (team.rosterPrompt) {
    out.push('', '## Roster prompt', '', team.rosterPrompt);
  }
  if (team.delegationPolicy || (team.delegationPolicyOverrides && Object.keys(team.delegationPolicyOverrides).length > 0)) {
    out.push('', '## Coordination rules');
    if (team.delegationPolicy) out.push(`- delegation: ${team.delegationPolicy}`);
    for (const [botId, policy] of Object.entries(team.delegationPolicyOverrides ?? {})) {
      out.push(`- ${botId}: ${policy}`);
    }
  }
  out.push('');
  return out.join('\n');
}

/** Sample document used by tests and the web UI's "paste box" placeholder. */
export const SAMPLE_TEAM_MARKDOWN = `# Team: Research Squad
> A crack team for deep research tasks.

## Members
- **Scout** (role: coordinator) — searches the web broadly
  - bot: scout
  - persona: You are a research coordinator. Break work down, delegate, synthesize.
  - tools: web_search, fetch_page
- **Writer** (role: member)
  - bot: writer

## Roster prompt
You coordinate the Research Squad. Delegate subtasks with the delegate tool and synthesize the final answer.

## Coordination rules
- delegation: always-ask
- writer: always-allow
`;
