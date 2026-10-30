// SPDX-License-Identifier: Apache-2.0
// Frontdoor state store: a single JSON file, written atomically
// (tmp + rename, mode 0600). It holds ONLY account identity basics,
// workspace addresses, single-use link codes, and session-token hashes.
// It never stores chat content, messages, or instance credentials —
// the registry is an address book, nothing more.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Account {
  /** Google `sub` claim — the stable account id. */
  id: string;
  email: string;
  name: string;
  picture?: string;
  createdAt: string;
  lastLoginAt: string;
}

export interface Workspace {
  id: string;
  accountId: string;
  name: string;
  instanceUrl: string;
  tier?: string;
  createdAt: string;
}

export interface LinkCode {
  code: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

export interface SessionRecord {
  accountId: string;
  createdAt: string;
  expiresAt: string;
}

interface StateFile {
  accounts: Account[];
  workspaces: Workspace[];
  linkCodes: LinkCode[];
  /** Keyed by sha256(session token) — plaintext session tokens are never stored. */
  sessions: Record<string, SessionRecord>;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function emptyState(): StateFile {
  return { accounts: [], workspaces: [], linkCodes: [], sessions: {} };
}

export class FrontdoorStore {
  private readonly file: string;
  private state: StateFile;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'frontdoor-state.json');
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StateFile>;
        this.state = {
          accounts: parsed.accounts ?? [],
          workspaces: parsed.workspaces ?? [],
          linkCodes: parsed.linkCodes ?? [],
          sessions: parsed.sessions ?? {},
        };
      } catch {
        this.state = emptyState();
      }
    } else {
      this.state = emptyState();
    }
  }

  /** Atomic persist: write a sibling tmp file (0600), then rename over. */
  save(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  // ---- accounts ----------------------------------------------------------

  upsertAccount(input: { sub: string; email: string; name: string; picture?: string }): Account {
    const now = new Date().toISOString();
    const existing = this.state.accounts.find((a) => a.id === input.sub);
    if (existing) {
      existing.email = input.email;
      existing.name = input.name;
      if (input.picture) existing.picture = input.picture;
      existing.lastLoginAt = now;
      this.save();
      return existing;
    }
    const account: Account = {
      id: input.sub,
      email: input.email,
      name: input.name,
      ...(input.picture ? { picture: input.picture } : {}),
      createdAt: now,
      lastLoginAt: now,
    };
    this.state.accounts.push(account);
    this.save();
    return account;
  }

  getAccount(id: string): Account | undefined {
    return this.state.accounts.find((a) => a.id === id);
  }

  // ---- sessions ----------------------------------------------------------

  createSession(tokenHash: string, accountId: string, ttlMs: number = SESSION_TTL_MS): SessionRecord {
    const now = Date.now();
    const record: SessionRecord = {
      accountId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    this.state.sessions[tokenHash] = record;
    this.save();
    return record;
  }

  getSession(tokenHash: string): SessionRecord | undefined {
    const record = this.state.sessions[tokenHash];
    if (!record) return undefined;
    if (Date.parse(record.expiresAt) <= Date.now()) {
      delete this.state.sessions[tokenHash];
      this.save();
      return undefined;
    }
    return record;
  }

  deleteSession(tokenHash: string): void {
    if (this.state.sessions[tokenHash]) {
      delete this.state.sessions[tokenHash];
      this.save();
    }
  }

  // ---- workspaces --------------------------------------------------------

  addWorkspace(input: { accountId: string; name: string; instanceUrl: string; tier?: string }): Workspace {
    const workspace: Workspace = {
      id: randomUUID(),
      accountId: input.accountId,
      name: input.name,
      instanceUrl: input.instanceUrl,
      ...(input.tier ? { tier: input.tier } : {}),
      createdAt: new Date().toISOString(),
    };
    this.state.workspaces.push(workspace);
    this.save();
    return workspace;
  }

  listWorkspaces(accountId: string): Workspace[] {
    return this.state.workspaces.filter((w) => w.accountId === accountId);
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.state.workspaces.find((w) => w.id === id);
  }

  findWorkspace(accountId: string, instanceUrl: string): Workspace | undefined {
    return this.state.workspaces.find((w) => w.accountId === accountId && w.instanceUrl === instanceUrl);
  }

  removeWorkspace(id: string, accountId: string): boolean {
    const before = this.state.workspaces.length;
    this.state.workspaces = this.state.workspaces.filter((w) => !(w.id === id && w.accountId === accountId));
    if (this.state.workspaces.length === before) return false;
    this.save();
    return true;
  }

  // ---- link codes ----------------------------------------------------------

  addLinkCode(input: { code: string; accountId: string; expiresAt: string }): LinkCode {
    const record: LinkCode = {
      code: input.code,
      accountId: input.accountId,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
    };
    this.state.linkCodes.push(record);
    this.save();
    return record;
  }

  getLinkCode(code: string): LinkCode | undefined {
    return this.state.linkCodes.find((c) => c.code === code);
  }

  burnLinkCode(code: string): void {
    const record = this.getLinkCode(code);
    if (record && !record.usedAt) {
      record.usedAt = new Date().toISOString();
      this.save();
    }
  }
}
