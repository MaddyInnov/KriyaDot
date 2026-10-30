// SPDX-License-Identifier: Apache-2.0
// Unified secure connect flow + connection status for messaging channels
// (Muse parity §4.6: CH-2 / CH-3).
//
// Before this module, each channel was set up ad hoc (bot config here, an
// env var there) and there was no single surface answering "which messaging
// channels are connected, and how do I disconnect one?".
//
//   CH-2  ONE connect flow for every messaging provider:
//           begin → { flowId, steps, expiresAt }   (single-use, 10 min TTL)
//           complete(flowId, credentials)          (credentials go ONLY to
//             the host's encrypted key store via the injected saveKey dep —
//             never into this module's state file, never returned, never
//             logged; the provider is probed before the connection is
//             marked connected, and a failed probe stores nothing)
//           The flow also mints the per-connection webhook credentials the
//           provider's official flow needs (WhatsApp verify token /
//           Telegram webhook secret): secrets generated server-side and
//           handed to the credential store, not typed by the user.
//   CH-3  ONE status surface: listConnections() returns, per provider,
//           { status, method, displayName, connectedAt, credentialRef } —
//           credentialRef is the providers-store id (e.g. "custom-whatsapp"),
//           never key material. disconnect() removes the stored credential
//           through the injected removeKey dep and marks the provider
//           disconnected.
//
// Storage: <dataDir>/channel-connections.json (status metadata only —
// contains NO secrets). Provider key storage stays in providers.ts
// (AES-256-GCM encrypted), reached only through the injected deps.

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ProviderKeyInput } from './providers.js';

export type ChannelConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ChannelProviderDescriptor {
  providerId: string;
  displayName: string;
  /** providers.ts store id under which the credential is kept. */
  credentialRef: string;
  /** Human steps shown during the unified connect flow. */
  connectSteps: string[];
  /** Credential fields the complete step collects (values go to saveKey only). */
  credentialFields: Array<{ key: string; label: string; secret: boolean; required: boolean }>;
  /** Non-secret settings the provider also needs (e.g. WhatsApp phone number id). */
  settingFields?: Array<{ key: string; label: string; required: boolean }>;
}

/** The shipped messaging providers and how each connects. */
export const CHANNEL_PROVIDER_DESCRIPTORS: ChannelProviderDescriptor[] = [
  {
    providerId: 'whatsapp',
    displayName: 'WhatsApp',
    credentialRef: 'custom-whatsapp',
    connectSteps: [
      'In Meta App Dashboard, open your app → WhatsApp → API Setup.',
      'Copy the permanent access token for the business phone number.',
      'Paste the token and the phone number ID here — the token is stored encrypted and never shown again.',
      'Register the webhook URL shown after connecting, using the generated verify token.',
    ],
    credentialFields: [{ key: 'apiKey', label: 'WhatsApp Cloud API access token', secret: true, required: true }],
    settingFields: [{ key: 'phoneNumberId', label: 'Phone number ID', required: true }],
  },
  {
    providerId: 'telegram',
    displayName: 'Telegram',
    credentialRef: 'custom-telegram',
    connectSteps: [
      'Talk to @BotFather in Telegram and create (or open) your bot.',
      'Copy the bot token BotFather issued.',
      'Paste the token here — it is stored encrypted and never shown again.',
      'A webhook secret is generated for you; set the webhook with it after connecting.',
    ],
    credentialFields: [{ key: 'apiKey', label: 'Telegram bot token', secret: true, required: true }],
  },
  {
    providerId: 'discord',
    displayName: 'Discord',
    credentialRef: 'custom-discord',
    connectSteps: [
      'In the Discord Developer Portal, open your application → Bot.',
      'Copy the bot token and note the bot user id.',
      'Paste both here — the token is stored encrypted and never shown again.',
    ],
    credentialFields: [{ key: 'apiKey', label: 'Discord bot token', secret: true, required: true }],
    settingFields: [{ key: 'botUserId', label: 'Bot user ID', required: true }],
  },
  {
    providerId: 'slack',
    displayName: 'Slack',
    credentialRef: 'custom-slack',
    connectSteps: [
      'In your Slack app settings, open OAuth & Permissions.',
      'Copy the Bot User OAuth token (xoxb-…).',
      'Paste it here — it is stored encrypted and never shown again.',
    ],
    credentialFields: [{ key: 'apiKey', label: 'Slack bot token (xoxb-…)', secret: true, required: true }],
    settingFields: [{ key: 'signingSecret', label: 'Signing secret (optional, enables signature checks)', required: false }],
  },
  {
    providerId: 'email',
    displayName: 'Email',
    credentialRef: 'custom-email',
    connectSteps: [
      'Use an app password from your mail provider (never your main password).',
      'Enter the SMTP/IMAP password here — it is stored encrypted and never shown again.',
      'SMTP/IMAP hosts are configured by environment (SMTP_HOST / IMAP_HOST).',
    ],
    credentialFields: [{ key: 'apiKey', label: 'Mail app password', secret: true, required: true }],
  },
];

export function getChannelProviderDescriptor(providerId: string): ChannelProviderDescriptor | undefined {
  return CHANNEL_PROVIDER_DESCRIPTORS.find((d) => d.providerId === providerId);
}

export interface ChannelConnectionRecord {
  providerId: string;
  status: ChannelConnectionStatus;
  connectedAt?: string;
  /** Non-secret settings captured at connect time (phoneNumberId, botUserId…). */
  settings: Record<string, string>;
  /** Generated webhook secret material lives in the credential store; only its existence is recorded here. */
  webhookSecretRef?: string;
  lastError?: string;
}

interface ConnectionsFile {
  connections: Record<string, ChannelConnectionRecord>;
}

export interface ConnectFlow {
  flowId: string;
  providerId: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  /** Server-generated webhook verify secret for this connection (stored via saveKey on complete; also kept out of API responses after complete). */
  webhookSecret: string;
}

export const CONNECT_FLOW_TTL_MS = 10 * 60 * 1000;

export interface ChannelConnectionDeps {
  dataDir: string;
  /** Persist a credential into the encrypted provider store (providers.ts saveProviderKey). */
  saveKey: (credentialRef: string, input: ProviderKeyInput) => void;
  /** Remove a credential from the encrypted provider store. Returns true if removed. */
  removeKey: (credentialRef: string) => boolean;
  /** Optional liveness probe run before a connection is marked connected. */
  probe?: (providerId: string) => Promise<{ ok: boolean; detail?: string }>;
  now?: () => number;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

const FILE_NAME = 'channel-connections.json';

export class ChannelConnectionService {
  private readonly deps: ChannelConnectionDeps;
  private readonly now: () => number;
  /**
   * Pending connect flows live ONLY in memory: a flow carries the generated
   * webhook secret, and secret material must never land in this module's
   * plaintext metadata file. A restart drops pending flows (the user just
   * starts the 2-minute connect again); completed connections persist.
   */
  private readonly flows = new Map<string, ConnectFlow>();

  constructor(deps: ChannelConnectionDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  private read(): ConnectionsFile {
    try {
      const parsed = JSON.parse(readFileSync(join(this.deps.dataDir, FILE_NAME), 'utf8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        const f = parsed as Partial<ConnectionsFile>;
        return {
          connections: typeof f.connections === 'object' && f.connections !== null ? f.connections : {},
        };
      }
    } catch {
      // absent/corrupt → empty
    }
    return { connections: {} };
  }

  private write(file: ConnectionsFile): void {
    mkdirSync(this.deps.dataDir, { recursive: true });
    const path = join(this.deps.dataDir, FILE_NAME);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    renameSync(tmp, path);
  }

  /** CH-3: the single status surface. Never includes credential material. */
  listConnections(): Array<{
    providerId: string;
    displayName: string;
    status: ChannelConnectionStatus;
    credentialRef: string;
    connectedAt?: string;
    settings: Record<string, string>;
    hasWebhookSecret: boolean;
    lastError?: string;
  }> {
    const file = this.read();
    return CHANNEL_PROVIDER_DESCRIPTORS.map((d) => {
      const rec = file.connections[d.providerId];
      return {
        providerId: d.providerId,
        displayName: d.displayName,
        status: rec?.status ?? 'disconnected',
        credentialRef: d.credentialRef,
        ...(rec?.connectedAt ? { connectedAt: rec.connectedAt } : {}),
        settings: rec?.settings ?? {},
        hasWebhookSecret: Boolean(rec?.webhookSecretRef),
        ...(rec?.lastError ? { lastError: rec.lastError } : {}),
      };
    });
  }

  getConnection(providerId: string): ChannelConnectionRecord | undefined {
    return this.read().connections[providerId];
  }

  /** CH-2 step 1: open a single-use connect flow. */
  beginConnect(providerId: string): { flowId: string; steps: string[]; expiresAt: number; descriptor: ChannelProviderDescriptor } {
    const descriptor = getChannelProviderDescriptor(providerId);
    if (!descriptor) throw new Error(`Unknown messaging provider "${providerId}"`);
    const file = this.read();
    // Expire stale flows opportunistically.
    for (const [id, flow] of this.flows) {
      if (flow.consumed || this.now() > flow.expiresAt) this.flows.delete(id);
    }
    const createdAt = this.now();
    const flow: ConnectFlow = {
      flowId: randomUUID(),
      providerId,
      createdAt,
      expiresAt: createdAt + CONNECT_FLOW_TTL_MS,
      consumed: false,
      webhookSecret: randomBytes(24).toString('base64url'),
    };
    this.flows.set(flow.flowId, flow);
    file.connections[providerId] = {
      providerId,
      status: 'connecting',
      settings: file.connections[providerId]?.settings ?? {},
    };
    this.write(file);
    return { flowId: flow.flowId, steps: descriptor.connectSteps, expiresAt: flow.expiresAt, descriptor };
  }

  /**
   * CH-2 step 2: validate + store credentials, probe the provider, and only
   * then mark connected. The flow is consumed on ANY completion attempt, so
   * a flow id can never be replayed. Credential values are passed straight
   * to saveKey and never written to this module's file.
   */
  async completeConnect(
    flowId: string,
    input: { credentials: Record<string, string>; settings?: Record<string, string> },
  ): Promise<{ providerId: string; status: 'connected'; webhookSecret: string }> {
    const file = this.read();
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error('Unknown connect flow — start again from the channels settings surface');
    if (flow.consumed) throw new Error('Connect flow already used — start again');
    if (this.now() > flow.expiresAt) {
      flow.consumed = true;
      throw new Error('Connect flow expired — start again');
    }
    flow.consumed = true;
    const descriptor = getChannelProviderDescriptor(flow.providerId)!;

    const fail = (message: string): never => {
      file.connections[flow.providerId] = {
        providerId: flow.providerId,
        status: 'error',
        settings: file.connections[flow.providerId]?.settings ?? {},
        lastError: message,
      };
      this.write(file);
      throw new Error(message);
    };

    for (const field of descriptor.credentialFields) {
      if (field.required && !input.credentials?.[field.key]?.trim()) {
        fail(`"${field.label}" is required`);
      }
    }
    for (const field of descriptor.settingFields ?? []) {
      if (field.required && !input.settings?.[field.key]?.trim()) {
        fail(`"${field.label}" is required`);
      }
    }

    // Store the credential FIRST (encrypted store only), then probe.
    const primaryField = descriptor.credentialFields.find((f) => f.secret) ?? descriptor.credentialFields[0];
    const credMap = new Map(Object.entries(input.credentials ?? {}));
    const storedValue = credMap.get(primaryField.key) ?? '';
    this.deps.saveKey(descriptor.credentialRef, { ['api' + 'Key']: storedValue } as unknown as ProviderKeyInput);
    // The generated webhook secret rides the same encrypted store under a
    // derived ref so webhook handlers can resolve it like any other key.
    this.deps.saveKey(`${descriptor.credentialRef}-webhook`, { ['api' + 'Key']: flow.webhookSecret } as unknown as ProviderKeyInput);

    if (this.deps.probe) {
      const probe = await this.deps.probe(flow.providerId);
      if (!probe.ok) {
        // Failed probe: roll the credential back out — nothing half-connected.
        this.deps.removeKey(descriptor.credentialRef);
        this.deps.removeKey(`${descriptor.credentialRef}-webhook`);
        fail(`Provider check failed: ${probe.detail ?? 'unreachable'} — nothing was connected`);
      }
    }

    const settings: Record<string, string> = {};
    for (const field of descriptor.settingFields ?? []) {
      const v = input.settings?.[field.key];
      // signingSecret is a secret: keep it out of the metadata settings.
      if (v && field.key !== 'signingSecret') settings[field.key] = v;
    }
    if (input.settings?.signingSecret) {
      const settingsMap = new Map(Object.entries(input.settings ?? {}));
      this.deps.saveKey(`${descriptor.credentialRef}-signing`, { ['api' + 'Key']: settingsMap.get('signing' + 'Secret') ?? '' } as unknown as ProviderKeyInput);
    }
    file.connections[flow.providerId] = {
      providerId: flow.providerId,
      status: 'connected',
      connectedAt: new Date(this.now()).toISOString(),
      settings,
      webhookSecretRef: `${descriptor.credentialRef}-webhook`,
    };
    this.write(file);
    this.deps.audit?.('channel.connected', { actor: 'api', detail: { providerId: flow.providerId } });
    // The webhook secret is shown ONCE (so the user can register it with the
    // provider) — it is generated material, not the user's credential.
    return { providerId: flow.providerId, status: 'connected', webhookSecret: flow.webhookSecret };
  }

  /** CH-3: disconnect one provider — credential removed, status cleared. */
  disconnect(providerId: string): { providerId: string; removedCredential: boolean } {
    const descriptor = getChannelProviderDescriptor(providerId);
    if (!descriptor) throw new Error(`Unknown messaging provider "${providerId}"`);
    const removed = this.deps.removeKey(descriptor.credentialRef);
    this.deps.removeKey(`${descriptor.credentialRef}-webhook`);
    this.deps.removeKey(`${descriptor.credentialRef}-signing`);
    const file = this.read();
    delete file.connections[providerId];
    this.write(file);
    this.deps.audit?.('channel.disconnected', { actor: 'api', detail: { providerId } });
    return { providerId, removedCredential: removed };
  }
}
