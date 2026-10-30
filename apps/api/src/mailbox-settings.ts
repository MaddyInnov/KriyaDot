// SPDX-License-Identifier: Apache-2.0
// Per-user mailbox-protocol settings (Muse parity audit §4.12: CN-2).
//
// Until now the email channel had exactly ONE configuration surface:
// process env (SMTP_HOST / IMAP_HOST / … in messaging.ts), shared by the
// whole install, with the password in the encrypted provider store under
// one fixed ref. CN-2 adds the per-user, per-mailbox settings surface:
//
//   MailboxSettings        one mailbox: label, address, username,
//                          incoming server (IMAP or POP3: host, port,
//                          security), outgoing server (SMTP: host, port,
//                          security), folder, poll interval, enabled.
//   Storage                NON-SECRET fields only, in
//                          mailbox-settings[.user].json (0600, atomic
//                          rename — same conventions as the pane stores).
//   Password               NEVER in the settings file, NEVER returned
//                          by any route, NEVER logged. It goes to the
//                          existing encrypted provider-key store (the
//                          SecureVault, @mvp/vault) under the secret
//                          name `mailbox-password-<mailboxId>`; routes
//                          accept it write-only on create/update and
//                          report only `hasPassword: boolean`.
//   Bridges                mailboxToImapConfig / mailboxToSmtpConfig
//                          produce the email-transport.ts config shapes
//                          messaging.ts already consumes, so the host
//                          can resolve a bot's mailbox from these
//                          settings instead of env. POP3 mailboxes are
//                          stored and surfaced honestly: the built-in
//                          transport speaks IMAP only, so the IMAP
//                          bridge returns null for POP3 and the status
//                          says why (no fake POP3 client is claimed).
//
// Routes (register-style; host mounts under /api):
//   GET    /mailbox-settings           → { mailboxes: [view…] }
//   POST   /mailbox-settings           → { …settings, password? } → 201 view
//   GET    /mailbox-settings/:id       → view
//   PUT    /mailbox-settings/:id       → partial settings; password sets,
//                                        clearPassword: true removes
//   DELETE /mailbox-settings/:id       → removes settings + vault secret
//
// Identity: the verified principal (principal.ts), namespaced per user
// exactly like the Composio / permissions stores.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import { SecureVault } from '@mvp/vault';
import { principalMiddleware, resolvePrincipal, type PrincipalContext } from './principal.js';
import type { ImapConfig, SmtpConfig } from './email-transport.js';

// ---------------------------------------------------------------------------
// Types + validation
// ---------------------------------------------------------------------------

export type MailSecurity = 'ssl' | 'starttls' | 'none';
export type IncomingProtocol = 'imap' | 'pop3';

export interface MailServerSettings {
  host: string;
  port: number;
  security: MailSecurity;
}

export interface MailboxSettings {
  id: string;
  label: string;
  /** The mailbox address, e.g. "me@example.com". */
  address: string;
  /** Login username (often the address; kept separate — providers differ). */
  username: string;
  incoming: MailServerSettings & { protocol: IncomingProtocol };
  outgoing: MailServerSettings;
  /** IMAP folder to poll (default INBOX). */
  mailbox: string;
  /** Background poll interval in minutes (1–1440). */
  pollMinutes: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** The route-facing view: settings + password PRESENCE only. */
export interface MailboxSettingsView extends MailboxSettings {
  hasPassword: boolean;
  /** Honest capability note (e.g. POP3 receive is not supported by the built-in transport). */
  notes: string[];
}

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const ADDRESS_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function defaultPortFor(kind: 'imap' | 'pop3' | 'smtp', security: MailSecurity): number {
  if (kind === 'imap') return security === 'ssl' ? 993 : 143;
  if (kind === 'pop3') return security === 'ssl' ? 995 : 110;
  return security === 'ssl' ? 465 : security === 'starttls' ? 587 : 25;
}

function isSecurity(v: unknown): v is MailSecurity {
  return v === 'ssl' || v === 'starttls' || v === 'none';
}

function validateServer(raw: unknown, kind: 'imap' | 'pop3' | 'smtp', field: string): MailServerSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`"${field}" must be an object { host, port?, security }`);
  }
  const v = raw as Record<string, unknown>;
  // A password (or any secret-shaped key) inside a server block is a hard
  // error: secrets only ever travel via the top-level write-only field.
  for (const key of Object.keys(v)) {
    if (/pass|secret|token|api[-_]?key/i.test(key)) {
      throw new Error(`"${field}.${key}" is not allowed — passwords are set via the top-level "password" field only`);
    }
  }
  if (typeof v.host !== 'string' || !HOST_RE.test(v.host.trim()) || v.host.includes('://')) {
    throw new Error(`"${field}.host" must be a bare hostname or IP (no scheme)`);
  }
  const security = v.security === undefined ? 'ssl' : v.security;
  if (!isSecurity(security)) throw new Error(`"${field}.security" must be ssl|starttls|none`);
  let port: number;
  if (v.port === undefined) {
    port = defaultPortFor(kind, security);
  } else if (typeof v.port === 'number' && Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535) {
    port = v.port;
  } else {
    throw new Error(`"${field}.port" must be an integer 1–65535`);
  }
  return { host: v.host.trim(), port, security };
}

export interface MailboxInput {
  label: string;
  address: string;
  username: string;
  incoming: MailboxSettings['incoming'];
  outgoing: MailServerSettings;
  mailbox: string;
  pollMinutes: number;
  enabled: boolean;
}

/** Validate a full mailbox-settings body (create). Throws Error with a user-safe message. */
export function validateMailboxInput(raw: unknown): MailboxInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mailbox body must be an object');
  const v = raw as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (/pass|secret|token|api[-_]?key/i.test(key) && key !== 'password') {
      throw new Error(`"${key}" is not an accepted field — use the write-only "password" field`);
    }
  }
  if (typeof v.label !== 'string' || !v.label.trim() || v.label.length > 80) {
    throw new Error('"label" is required (non-empty string, max 80 chars)');
  }
  if (typeof v.address !== 'string' || !ADDRESS_RE.test(v.address.trim())) {
    throw new Error('"address" must be an email address');
  }
  const username = v.username === undefined ? v.address : v.username;
  if (typeof username !== 'string' || !username.trim() || username.length > 200) {
    throw new Error('"username" must be a non-empty string (max 200 chars)');
  }
  const incomingRaw = (v.incoming ?? {}) as Record<string, unknown>;
  const protocolRaw = incomingRaw.protocol === undefined ? 'imap' : incomingRaw.protocol;
  if (protocolRaw !== 'imap' && protocolRaw !== 'pop3') throw new Error('"incoming.protocol" must be imap|pop3');
  const protocol: IncomingProtocol = protocolRaw;
  const incoming: MailboxSettings['incoming'] = { ...validateServer(incomingRaw, protocol, 'incoming'), protocol };
  const outgoing = validateServer(v.outgoing, 'smtp', 'outgoing');
  const mailbox = v.mailbox === undefined ? 'INBOX' : v.mailbox;
  if (typeof mailbox !== 'string' || !mailbox.trim() || mailbox.length > 100) {
    throw new Error('"mailbox" must be a non-empty string (max 100 chars)');
  }
  const pollMinutes = v.pollMinutes === undefined ? 5 : v.pollMinutes;
  if (typeof pollMinutes !== 'number' || !Number.isInteger(pollMinutes) || pollMinutes < 1 || pollMinutes > 1440) {
    throw new Error('"pollMinutes" must be an integer 1–1440');
  }
  const enabled = v.enabled === undefined ? true : v.enabled;
  if (typeof enabled !== 'boolean') throw new Error('"enabled" must be a boolean');
  return {
    label: v.label.trim(),
    address: (v.address as string).trim(),
    username: (username as string).trim(),
    incoming,
    outgoing,
    mailbox: mailbox.trim(),
    pollMinutes,
    enabled,
  };
}

// ---------------------------------------------------------------------------
// Storage (non-secret JSON) + password vault seam
// ---------------------------------------------------------------------------

const MAILBOX_FILE = 'mailbox-settings';

function sanitizeNamespace(ns: string): string {
  return ns.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64) || 'user';
}

function mailboxPath(dataDir: string, userId: string): string {
  const suffix = userId === 'default-user' ? '' : `.${sanitizeNamespace(userId)}`;
  return path.join(dataDir, `${MAILBOX_FILE}${suffix}.json`);
}

interface MailboxFileShape {
  mailboxes: MailboxSettings[];
}

export function listMailboxSettings(dataDir: string, userId: string): MailboxSettings[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(mailboxPath(dataDir, userId), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const list = (parsed as MailboxFileShape).mailboxes;
      if (Array.isArray(list)) return list.filter((m) => m && typeof m.id === 'string');
    }
  } catch {
    // Missing or corrupt → empty (never 500 on a settings read).
  }
  return [];
}

function saveMailboxSettings(dataDir: string, userId: string, mailboxes: MailboxSettings[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = mailboxPath(dataDir, userId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ mailboxes } satisfies MailboxFileShape, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Vault secret name holding one mailbox's password. Server-side only. */
export function mailboxPasswordSecretName(mailboxId: string): string {
  return `mailbox-password-${mailboxId}`;
}

/** Minimal vault surface (SecureVault satisfies it; tests may stub it). */
export interface MailboxPasswordVault {
  get(name: string): { value: string } | undefined;
  create(name: string, value: string, description?: string): unknown;
  update(name: string, value: string): unknown;
  delete(name: string): boolean;
}

export type MailboxVaultFactory = (dataDir: string, userId: string) => MailboxPasswordVault;

export const defaultMailboxVaultFactory: MailboxVaultFactory = (dataDir, userId) =>
  new SecureVault(dataDir, userId, userId) as unknown as MailboxPasswordVault;

function setMailboxPassword(vault: MailboxPasswordVault, mailboxId: string, password: string): void {
  const name = mailboxPasswordSecretName(mailboxId);
  let existing: { value: string } | undefined;
  try {
    existing = vault.get(name);
  } catch {
    existing = undefined;
  }
  if (existing) vault.update(name, password);
  else vault.create(name, password, 'Mailbox password (CN-2 per-mailbox protocol settings)');
}

function hasMailboxPassword(vault: MailboxPasswordVault, mailboxId: string): boolean {
  try {
    return vault.get(mailboxPasswordSecretName(mailboxId)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The stored password for one mailbox — SERVER-SIDE ONLY (host resolvers,
 * never a route). Returns undefined when none is stored.
 */
export function getMailboxPassword(
  dataDir: string,
  userId: string,
  mailboxId: string,
  vaultFactory: MailboxVaultFactory = defaultMailboxVaultFactory,
): string | undefined {
  try {
    return vaultFactory(dataDir, userId).get(mailboxPasswordSecretName(mailboxId))?.value;
  } catch {
    return undefined;
  }
}

export function toMailboxView(
  dataDir: string,
  userId: string,
  mailbox: MailboxSettings,
  vaultFactory: MailboxVaultFactory = defaultMailboxVaultFactory,
): MailboxSettingsView {
  const notes: string[] = [];
  if (mailbox.incoming.protocol === 'pop3') {
    notes.push('POP3 receive is not supported by the built-in mail transport (IMAP only) — this mailbox can send via SMTP; receiving needs IMAP settings or a Composio Gmail account.');
  }
  if (mailbox.incoming.security === 'none' || mailbox.outgoing.security === 'none') {
    notes.push('A server is configured with security "none" — credentials would cross the network in plaintext. Prefer ssl or starttls.');
  }
  return { ...mailbox, hasPassword: hasMailboxPassword(vaultFactory(dataDir, userId), mailbox.id), notes };
}

// ---------------------------------------------------------------------------
// Bridges to the email transport configs (messaging.ts shapes)
// ---------------------------------------------------------------------------

function toTransportSecurity(security: MailSecurity): { secure: boolean; starttls: boolean } {
  return { secure: security === 'ssl', starttls: security === 'starttls' };
}

/**
 * IMAP config for the built-in poller, or null for POP3 mailboxes (the
 * transport has no POP3 client — see the view note). Throws when no
 * password is stored: a poller without credentials must fail loudly at
 * wiring time, not silently at poll time.
 */
export function mailboxToImapConfig(mailbox: MailboxSettings, password: string | undefined): ImapConfig | null {
  if (mailbox.incoming.protocol !== 'imap') return null;
  if (!password) throw new Error(`mailbox "${mailbox.label}" has no stored password — set one before enabling receive`);
  const { secure, starttls } = toTransportSecurity(mailbox.incoming.security);
  return {
    host: mailbox.incoming.host,
    port: mailbox.incoming.port,
    secure,
    starttls,
    user: mailbox.username,
    pass: password,
    mailbox: mailbox.mailbox,
  };
}

/** SMTP config for the built-in sender. Password optional (open relays exist). */
export function mailboxToSmtpConfig(mailbox: MailboxSettings, password: string | undefined): SmtpConfig {
  const { secure, starttls } = toTransportSecurity(mailbox.outgoing.security);
  return {
    host: mailbox.outgoing.host,
    port: mailbox.outgoing.port,
    secure,
    starttls,
    user: mailbox.username,
    pass: password,
    from: mailbox.address,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface MailboxSettingsDeps {
  dataDir: string;
  loopbackToken?: string;
  jwtSecret?: string;
  vaultFactory?: MailboxVaultFactory;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown }) => void;
  now?: () => number;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export function registerMailboxSettingsRoutes(router: Router, deps: MailboxSettingsDeps): void {
  const pctx: PrincipalContext = { dataDir: deps.dataDir, loopbackToken: deps.loopbackToken, jwtSecret: deps.jwtSecret };
  const vaultFactory = deps.vaultFactory ?? defaultMailboxVaultFactory;
  const now = deps.now ?? (() => Date.now());
  function callerOf(req: Request): string {
    const userId = resolvePrincipal(req, pctx)?.userId;
    if (!userId) throw new Error('unauthenticated');
    return userId;
  }
  const audit = (req: Request, action: string, detail?: unknown) => {
    try {
      deps.audit?.(action, { actor: callerOf(req), toolName: 'mailbox-settings', detail });
    } catch {
      // Audit must never break a settings write.
    }
  };

  const r = express.Router();
  r.use(principalMiddleware(pctx));

  r.get('/', (req: Request, res: Response) => {
    const userId = callerOf(req);
    res.json({
      ok: true,
      mailboxes: listMailboxSettings(deps.dataDir, userId).map((m) => toMailboxView(deps.dataDir, userId, m, vaultFactory)),
    });
  });

  r.post('/', (req: Request, res: Response) => {
    const userId = callerOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const input = validateMailboxInput(body);
      const password = body.password;
      if (password !== undefined && (typeof password !== 'string' || password.length === 0 || password.length > 1024)) {
        throw new Error('"password" must be a non-empty string (max 1024 chars) when present');
      }
      const ts = now();
      const mailbox: MailboxSettings = { ...input, id: randomUUID(), createdAt: ts, updatedAt: ts };
      const all = listMailboxSettings(deps.dataDir, userId);
      all.push(mailbox);
      saveMailboxSettings(deps.dataDir, userId, all);
      if (typeof password === 'string') {
        setMailboxPassword(vaultFactory(deps.dataDir, userId), mailbox.id, password);
      }
      audit(req, 'mailbox.created', { id: mailbox.id, address: mailbox.address, protocol: mailbox.incoming.protocol, hasPassword: typeof password === 'string' });
      res.status(201).json({ ok: true, mailbox: toMailboxView(deps.dataDir, userId, mailbox, vaultFactory) });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'invalid mailbox settings'));
    }
  });

  r.get('/:id', (req: Request, res: Response) => {
    const userId = callerOf(req);
    const found = listMailboxSettings(deps.dataDir, userId).find((m) => m.id === req.params.id);
    if (!found) {
      res.status(404).json(errorBody(`unknown mailbox: ${req.params.id}`));
      return;
    }
    res.json({ ok: true, mailbox: toMailboxView(deps.dataDir, userId, found, vaultFactory) });
  });

  r.put('/:id', (req: Request, res: Response) => {
    const userId = callerOf(req);
    const all = listMailboxSettings(deps.dataDir, userId);
    const existing = all.find((m) => m.id === req.params.id);
    if (!existing) {
      res.status(404).json(errorBody(`unknown mailbox: ${req.params.id}`));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      // Partial update: merge provided fields over the stored settings,
      // then validate the merged whole (the validator is the one gate).
      const merged: Record<string, unknown> = {
        label: existing.label,
        address: existing.address,
        username: existing.username,
        incoming: existing.incoming,
        outgoing: existing.outgoing,
        mailbox: existing.mailbox,
        pollMinutes: existing.pollMinutes,
        enabled: existing.enabled,
      };
      for (const key of ['label', 'address', 'username', 'incoming', 'outgoing', 'mailbox', 'pollMinutes', 'enabled'] as const) {
        if (body[key] !== undefined) merged[key] = body[key];
      }
      const input = validateMailboxInput(merged);
      const password = body.password;
      if (password !== undefined && (typeof password !== 'string' || password.length === 0 || password.length > 1024)) {
        throw new Error('"password" must be a non-empty string (max 1024 chars) when present');
      }
      if (body.clearPassword !== undefined && typeof body.clearPassword !== 'boolean') {
        throw new Error('"clearPassword" must be a boolean when present');
      }
      if (typeof password === 'string' && body.clearPassword === true) {
        throw new Error('pass either "password" or "clearPassword", not both');
      }
      const updated: MailboxSettings = { ...existing, ...input, updatedAt: now() };
      saveMailboxSettings(deps.dataDir, userId, all.map((m) => (m.id === updated.id ? updated : m)));
      const vault = vaultFactory(deps.dataDir, userId);
      if (typeof password === 'string') setMailboxPassword(vault, updated.id, password);
      if (body.clearPassword === true) {
        try {
          vault.delete(mailboxPasswordSecretName(updated.id));
        } catch {
          // No stored password is a fine end state for a clear.
        }
      }
      audit(req, 'mailbox.updated', { id: updated.id, passwordChanged: typeof password === 'string', passwordCleared: body.clearPassword === true });
      res.json({ ok: true, mailbox: toMailboxView(deps.dataDir, userId, updated, vaultFactory) });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'invalid mailbox settings'));
    }
  });

  r.delete('/:id', (req: Request, res: Response) => {
    const userId = callerOf(req);
    const all = listMailboxSettings(deps.dataDir, userId);
    const next = all.filter((m) => m.id !== req.params.id);
    if (next.length === all.length) {
      res.status(404).json(errorBody(`unknown mailbox: ${req.params.id}`));
      return;
    }
    saveMailboxSettings(deps.dataDir, userId, next);
    try {
      vaultFactory(deps.dataDir, userId).delete(mailboxPasswordSecretName(req.params.id));
    } catch {
      // Secret already gone — the settings delete still stands.
    }
    audit(req, 'mailbox.deleted', { id: req.params.id });
    res.json({ ok: true, deleted: req.params.id });
  });

  router.use('/mailbox-settings', r);
}
