// SPDX-License-Identifier: Apache-2.0
// CN-2: per-user mailbox-protocol settings. Core guarantees under test:
// the password NEVER lands in the settings file and NEVER appears in any
// response; it lives only in the encrypted vault under a derived name;
// validation refuses secret-shaped fields anywhere else; the transport
// bridges produce messaging.ts's config shapes honestly (POP3 → null).

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultPortFor,
  getMailboxPassword,
  listMailboxSettings,
  mailboxPasswordSecretName,
  mailboxToImapConfig,
  mailboxToSmtpConfig,
  registerMailboxSettingsRoutes,
  validateMailboxInput,
  type MailboxSettings,
} from '../src/mailbox-settings.js';

const OWNER_TOKEN = 'mailbox-settings-test-token';
const PASSWORD = 'app-password-123';

let dir: string;
let server: { close(cb: () => void): void } | null = null;
let baseUrl = '';

const VALID_BODY = {
  label: 'Personal Gmail',
  address: 'me@example.com',
  incoming: { protocol: 'imap', host: 'imap.example.com', security: 'ssl' },
  outgoing: { host: 'smtp.example.com', security: 'starttls' },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mailbox-settings-'));
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerMailboxSettingsRoutes(router, { dataDir: dir, loopbackToken: OWNER_TOKEN });
  app.use('/api', router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/api`;
      resolve();
    });
  });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${OWNER_TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text || '{}'), text };
}

describe('validation', () => {
  it('applies protocol/security port defaults', () => {
    expect(defaultPortFor('imap', 'ssl')).toBe(993);
    expect(defaultPortFor('imap', 'starttls')).toBe(143);
    expect(defaultPortFor('pop3', 'ssl')).toBe(995);
    expect(defaultPortFor('smtp', 'ssl')).toBe(465);
    expect(defaultPortFor('smtp', 'starttls')).toBe(587);
    const input = validateMailboxInput(VALID_BODY);
    expect(input.incoming.port).toBe(993);
    expect(input.outgoing.port).toBe(587);
    expect(input.username).toBe('me@example.com'); // defaults to the address
    expect(input.mailbox).toBe('INBOX');
  });

  it('rejects bad hosts, ports, protocols and addresses', () => {
    expect(() => validateMailboxInput({ ...VALID_BODY, address: 'nope' })).toThrow(/email address/);
    expect(() => validateMailboxInput({ ...VALID_BODY, incoming: { host: 'https://imap.example.com' } })).toThrow(/bare hostname/);
    expect(() => validateMailboxInput({ ...VALID_BODY, incoming: { host: 'h', port: 70000 } })).toThrow(/1–65535/);
    expect(() => validateMailboxInput({ ...VALID_BODY, incoming: { protocol: 'gopher', host: 'h' } })).toThrow(/imap\|pop3/);
    expect(() => validateMailboxInput({ ...VALID_BODY, pollMinutes: 0 })).toThrow(/1–1440/);
  });

  it('refuses secret-shaped fields anywhere but the write-only password', () => {
    expect(() =>
      validateMailboxInput({ ...VALID_BODY, incoming: { host: 'h', password: 'x' } }),
    ).toThrow(/top-level "password"/);
    expect(() => validateMailboxInput({ ...VALID_BODY, apiToken: 'x' })).toThrow(/not an accepted field/);
  });
});

describe('routes: password handling', () => {
  it('stores the password ONLY in the vault; file + responses never contain it', async () => {
    const created = await req('POST', '/mailbox-settings', { ...VALID_BODY, password: PASSWORD });
    expect(created.status).toBe(201);
    expect(created.json.mailbox.hasPassword).toBe(true);
    expect(created.text).not.toContain(PASSWORD);
    const id = created.json.mailbox.id as string;

    // The settings file on disk holds no secret material.
    const settingsRaw = readFileSync(join(dir, 'mailbox-settings.json'), 'utf8');
    expect(settingsRaw).not.toContain(PASSWORD);
    expect(settingsRaw).not.toMatch(/password/i);

    // The vault holds it (encrypted at rest), retrievable server-side only.
    expect(getMailboxPassword(dir, 'default-user', id)).toBe(PASSWORD);
    const vaultFile = readdirSync(dir).find((f) => f.startsWith('vault'));
    expect(vaultFile).toBeTruthy();
    expect(readFileSync(join(dir, vaultFile!), 'utf8')).not.toContain(PASSWORD);

    // Reads never echo it.
    const list = await req('GET', '/mailbox-settings');
    expect(list.text).not.toContain(PASSWORD);
    expect(list.json.mailboxes[0].hasPassword).toBe(true);
    expect(mailboxPasswordSecretName(id)).toBe(`mailbox-password-${id}`);
  });

  it('update can rotate and clear the password; delete removes the secret', async () => {
    const created = await req('POST', '/mailbox-settings', { ...VALID_BODY, password: PASSWORD });
    const id = created.json.mailbox.id as string;
    const rotated = await req('PUT', `/mailbox-settings/${id}`, { password: 'new-pass-456', label: 'Renamed' });
    expect(rotated.status).toBe(200);
    expect(rotated.json.mailbox.label).toBe('Renamed');
    expect(getMailboxPassword(dir, 'default-user', id)).toBe('new-pass-456');
    const cleared = await req('PUT', `/mailbox-settings/${id}`, { clearPassword: true });
    expect(cleared.json.mailbox.hasPassword).toBe(false);
    expect(getMailboxPassword(dir, 'default-user', id)).toBeUndefined();
    await req('PUT', `/mailbox-settings/${id}`, { password: PASSWORD });
    const deleted = await req('DELETE', `/mailbox-settings/${id}`);
    expect(deleted.status).toBe(200);
    expect(getMailboxPassword(dir, 'default-user', id)).toBeUndefined();
    expect(listMailboxSettings(dir, 'default-user')).toHaveLength(0);
    const again = await req('DELETE', `/mailbox-settings/${id}`);
    expect(again.status).toBe(404);
  });

  it('rejects password+clearPassword together and unknown ids', async () => {
    const created = await req('POST', '/mailbox-settings', VALID_BODY);
    const id = created.json.mailbox.id as string;
    const both = await req('PUT', `/mailbox-settings/${id}`, { password: 'x', clearPassword: true });
    expect(both.status).toBe(400);
    const ghost = await req('GET', '/mailbox-settings/nope');
    expect(ghost.status).toBe(404);
  });

  it('POP3 mailboxes are stored with the honest receive note', async () => {
    const created = await req('POST', '/mailbox-settings', {
      ...VALID_BODY,
      incoming: { protocol: 'pop3', host: 'pop.example.com', security: 'ssl' },
    });
    expect(created.status).toBe(201);
    expect(created.json.mailbox.incoming.port).toBe(995);
    expect(created.json.mailbox.notes.join(' ')).toMatch(/POP3 receive is not supported/);
  });
});

describe('transport bridges', () => {
  const base: MailboxSettings = {
    id: 'mb-1',
    label: 'Work',
    address: 'me@example.com',
    username: 'me@example.com',
    incoming: { protocol: 'imap', host: 'imap.example.com', port: 993, security: 'ssl' },
    outgoing: { host: 'smtp.example.com', port: 587, security: 'starttls' },
    mailbox: 'INBOX',
    pollMinutes: 5,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };

  it('builds ImapConfig / SmtpConfig in messaging.ts shapes', () => {
    expect(mailboxToImapConfig(base, 'pw')).toEqual({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      starttls: false,
      user: 'me@example.com',
      pass: 'pw',
      mailbox: 'INBOX',
    });
    expect(mailboxToSmtpConfig(base, 'pw')).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      starttls: true,
      user: 'me@example.com',
      pass: 'pw',
      from: 'me@example.com',
    });
  });

  it('IMAP bridge requires a password and returns null for POP3', () => {
    expect(() => mailboxToImapConfig(base, undefined)).toThrow(/no stored password/);
    expect(mailboxToImapConfig({ ...base, incoming: { ...base.incoming, protocol: 'pop3' } }, 'pw')).toBeNull();
  });
});
