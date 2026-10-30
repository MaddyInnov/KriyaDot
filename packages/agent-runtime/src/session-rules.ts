// SPDX-License-Identifier: Apache-2.0
/**
 * Session standing rules (Octomind parity #46).
 *
 * A standing rule is a short instruction a user (or the agent, with
 * the user's approval) pins to a session — "always answer in Hindi",
 * "never touch the prod database" — that must keep applying turn
 * after turn AND survive into later sessions, unlike a one-off
 * instruction in a single message. Before this module standing
 * material existed only at bot scope (the system prompt), workspace
 * scope (project instructions), or governance scope (policy);
 * nothing was settable in-session.
 *
 * This module is the store unit:
 *   - rules are keyed by an owner scope: `session:<id>` for rules set
 *     in one session, `bot:<id>` for rules a session elects to carry
 *     across all of the bot's sessions;
 *   - `rulesFor(sessionId, botId)` merges bot-carried rules with the
 *     session's own (session rules win on identical text);
 *   - `carryAcrossSessions(fromSessionId, botId)` promotes a session's
 *     rules to bot scope so the NEXT session inherits them;
 *   - persistence is pluggable (in-memory, or a JSON file store with
 *     the same plain-file pattern as the background-run store), so
 *     rules survive restarts when the host wires a file store.
 *
 * Integration point (fenced, see the closure report): sessions.ts /
 * runtime.ts should render `renderStandingRules(rulesFor(...))` into
 * the per-turn system context and expose set/list/remove to the chat
 * surfaces; the store itself is host-constructed exactly like
 * BackgroundRunRegistry.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StandingRule {
  id: string;
  /** The rule text, one instruction. */
  text: string;
  /** Scope the rule was set under: `session:<id>` or `bot:<id>`. */
  scope: string;
  /** Session that created the rule (provenance), when known. */
  createdInSessionId?: string;
  createdAt: number;
}

export interface StandingRuleStore {
  load(): StandingRule[];
  save(rules: StandingRule[]): void;
}

/** In-memory store (tests / explicit opt-out of persistence). */
export class MemoryStandingRuleStore implements StandingRuleStore {
  private data: StandingRule[] = [];
  load(): StandingRule[] {
    return this.data.map((r) => ({ ...r }));
  }
  save(rules: StandingRule[]): void {
    this.data = rules.map((r) => ({ ...r }));
  }
}

/** JSON-file store; persistence failures never break a turn. */
export class FileStandingRuleStore implements StandingRuleStore {
  constructor(private readonly path: string) {}
  load(): StandingRule[] {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as StandingRule[]) : [];
    } catch {
      return [];
    }
  }
  save(rules: StandingRule[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(rules));
    } catch {
      /* persistence must never break a turn */
    }
  }
}

const MAX_RULE_CHARS = 500;

export class SessionStandingRules {
  private readonly rules: StandingRule[] = [];
  private readonly store?: StandingRuleStore;

  constructor(opts: { store?: StandingRuleStore } = {}) {
    this.store = opts.store;
    if (this.store) {
      for (const r of this.store.load()) {
        if (r && typeof r.text === 'string' && typeof r.scope === 'string') this.rules.push(r);
      }
    }
  }

  private persist(): void {
    this.store?.save([...this.rules]);
  }

  /** Add a rule under a scope (`session:<id>` or `bot:<id>`). Dedupes identical text per scope. */
  add(input: { scope: string; text: string; createdInSessionId?: string }): StandingRule {
    const text = input.text.trim().slice(0, MAX_RULE_CHARS);
    if (!text) throw new Error('standing rule text is required');
    const existing = this.rules.find((r) => r.scope === input.scope && r.text === text);
    if (existing) return existing;
    const rule: StandingRule = {
      id: `rule-${randomUUID().slice(0, 8)}`,
      text,
      scope: input.scope,
      createdInSessionId: input.createdInSessionId,
      createdAt: Date.now(),
    };
    this.rules.push(rule);
    this.persist();
    return rule;
  }

  /** Convenience: set a rule in a session's own scope. */
  addForSession(sessionId: string, text: string): StandingRule {
    return this.add({ scope: `session:${sessionId}`, text, createdInSessionId: sessionId });
  }

  /** Convenience: set a rule carried across all of a bot's sessions. */
  addForBot(botId: string, text: string, createdInSessionId?: string): StandingRule {
    return this.add({ scope: `bot:${botId}`, text, createdInSessionId });
  }

  /** Remove a rule by id. Returns false when unknown. */
  remove(id: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this.persist();
    return true;
  }

  /** Remove every rule under one scope. Returns the count removed. */
  clearScope(scope: string): number {
    const before = this.rules.length;
    for (let i = this.rules.length - 1; i >= 0; i--) {
      if (this.rules[i]!.scope === scope) this.rules.splice(i, 1);
    }
    const removed = before - this.rules.length;
    if (removed > 0) this.persist();
    return removed;
  }

  /** Rules under exactly one scope, oldest first. */
  listScope(scope: string): StandingRule[] {
    return this.rules.filter((r) => r.scope === scope);
  }

  /**
   * The effective rules for a session: bot-carried rules first, then
   * the session's own, deduped by text (the session's copy wins the
   * position). This is the list a turn renders into context.
   */
  rulesFor(sessionId: string, botId?: string): StandingRule[] {
    const out: StandingRule[] = [];
    const seen = new Set<string>();
    const push = (r: StandingRule): void => {
      if (seen.has(r.text)) return;
      seen.add(r.text);
      out.push(r);
    };
    if (botId) for (const r of this.listScope(`bot:${botId}`)) push(r);
    for (const r of this.listScope(`session:${sessionId}`)) push(r);
    return out;
  }

  /**
   * Promote a session's own rules to bot scope so later sessions of
   * the same bot inherit them ("carry across sessions"). Returns the
   * bot-scope rules after promotion.
   */
  carryAcrossSessions(fromSessionId: string, botId: string): StandingRule[] {
    for (const r of this.listScope(`session:${fromSessionId}`)) {
      this.addForBot(botId, r.text, fromSessionId);
    }
    return this.listScope(`bot:${botId}`);
  }
}

/** Render rules as the system-context block a turn prepends. '' when empty. */
export function renderStandingRules(rules: StandingRule[]): string {
  if (rules.length === 0) return '';
  const lines = rules.map((r, i) => `${i + 1}. ${r.text}`);
  return `Standing rules for this session (set by the user; follow them unless a newer instruction conflicts):\n${lines.join('\n')}`;
}
