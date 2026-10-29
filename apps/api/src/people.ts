// SPDX-License-Identifier: Apache-2.0
// Multiplayer layer (W7) — API-side people service.
//
// Owns the wiring between the agent-runtime people primitives
// (PeopleStore, TeamInboxStore, RelayService) and the API app:
// - Bot ownership overlay (<dataDir>/bot-owners.json), applied to the
//   in-memory roster at boot exactly like bot-policies/personas overlays.
// - The production RelaySender: delivers via the existing messaging
//   gateway providers (messaging.ts registry). The 'email' channel is
//   just another provider id in that registry — deployments that
//   register an email provider get email relays with no code change.
// - Reply delivery: a person's reply is appended to the originating chat
//   session as fenced external content (RelayService does the fencing).
// - Needs-you fan-out: when a needs-you inbox item lands for a person,
//   their designated chief bot gets a notification turn (per-person
//   chief; the default user keeps the global Chief behaviour — enforced
//   in notifyPersonChief) and paired devices get a push.
//
// Person context (trust model): see resolvePersonContext — a UI-level
// identity selector (header/query/body), NOT cryptographic auth. The
// tenancy layer provides real auth for hosted deployments.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import {
  DEFAULT_PERSON_ID,
  RelayService,
  notifyPersonChief,
  parsePersonMentions,
  type BotConfig,
  type OnBehalfOfLedger,
  type PeopleStore,
  type Person,
  type RelaySender,
  type TeamInboxItem,
  type TeamInboxStore,
} from '@mvp/agent-runtime';
import { getMessageProvider } from './messaging.js';
import type { GovernanceGateway } from '@mvp/governance';

// ---------------------------------------------------------------------------
// Bot ownership overlay (<dataDir>/bot-owners.json)
// ---------------------------------------------------------------------------

const OWNERS_FILE = 'bot-owners.json';

export function loadBotOwners(dataDir: string): Record<string, string> {
  try {
    const raw = readFileSync(join(dataDir, OWNERS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { owners?: unknown };
    if (parsed && typeof parsed === 'object' && parsed.owners && typeof parsed.owners === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.owners as Record<string, unknown>)) {
        if (typeof v === 'string' && v) out[k] = v;
      }
      return out;
    }
  } catch {
    // Absent/corrupt → no owners recorded (every bot = default user).
  }
  return {};
}

/** Apply persisted owners onto the in-memory roster (boot). Mutates bots. */
export function applyBotOwners(bots: BotConfig[], dataDir: string): void {
  const owners = loadBotOwners(dataDir);
  for (const bot of bots) {
    const owner = owners[bot.id];
    if (owner) bot.ownerId = owner;
  }
}

/**
 * Set (or clear, with null) a bot's owner: updates the in-memory bot and
 * persists the overlay. Returns the previous owner person id.
 */
export function saveBotOwner(
  dataDir: string,
  bots: BotConfig[],
  botId: string,
  personId: string | null,
): { previousOwnerId: string } {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot "${botId}"`);
  const previousOwnerId = bot.ownerId ?? DEFAULT_PERSON_ID;
  const owners = loadBotOwners(dataDir);
  if (personId) {
    bot.ownerId = personId;
    owners[botId] = personId;
  } else {
    delete bot.ownerId;
    delete owners[botId];
  }
  mkdirSync(dataDir, { recursive: true });
  const tmp = join(dataDir, `${OWNERS_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify({ owners }, null, 2), 'utf8');
  renameSync(tmp, join(dataDir, OWNERS_FILE));
  return { previousOwnerId };
}

// ---------------------------------------------------------------------------
// Person context
// ---------------------------------------------------------------------------

/**
 * Resolve the acting person for a request: `x-person-id` header first,
 * then `?personId=`, then a JSON body `personId`. Falls back to the
 * default user. This is a UI-level identity selector for the local app,
 * not authentication (see the trust-model note in people.ts upstream).
 */
export function resolvePersonContext(req: Request): string {
  const header = req.headers['x-person-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const q = req.query?.personId;
  if (typeof q === 'string' && q.trim()) return q.trim();
  const body = (req as { body?: unknown }).body;
  if (body && typeof body === 'object') {
    const p = (body as { personId?: unknown }).personId;
    if (typeof p === 'string' && p.trim()) return p.trim();
  }
  return DEFAULT_PERSON_ID;
}

/**
 * Like resolvePersonContext, but returns undefined when the request
 * carries NO explicit person context — used by list endpoints that must
 * keep their pre-W7 "list everything" behaviour for clients that don't
 * send a person context, and filter only when one is presented.
 */
export function resolveExplicitPersonContext(req: Request): string | undefined {
  const header = req.headers['x-person-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const q = req.query?.personId;
  if (typeof q === 'string' && q.trim()) return q.trim();
  return undefined;
}

// ---------------------------------------------------------------------------
// People service
// ---------------------------------------------------------------------------

export interface PeopleServiceDeps {
  dataDir: string;
  people: PeopleStore;
  inbox: TeamInboxStore;
  getBots: () => BotConfig[];
  governance: Pick<GovernanceGateway, 'audit'>;
  ledger?: Pick<OnBehalfOfLedger, 'record'>;
  /**
   * Runtime access for chief notification turns + reply delivery into
   * chat sessions. Late-bound in index.ts (the runtime exists before the
   * service is used, but the service is constructed alongside it).
   */
  getRuntime: () => {
    runTurn: (opts: {
      bot: BotConfig;
      message: string;
      onEvent: (e: unknown) => void;
    }) => Promise<unknown>;
    sessionStore: { appendMessage: (sessionId: string, msg: { role: 'user'; content: string }) => void };
  } | undefined;
  /** Paired-device push (late-bound; optional). */
  getPush?: () => {
    notify: (req: {
      kind: 'needsInput';
      botId: string;
      botName: string;
      title: string;
      body: string;
    }) => Promise<void>;
  } | undefined;
  /** Injectable sender for tests; production uses the messaging gateway. */
  sender?: RelaySender;
  /** Extra needs-you observers (tests). */
  onNeedsYouExtra?: (person: Person, item: TeamInboxItem) => void | Promise<void>;
}

export interface PeopleService {
  people: PeopleStore;
  inbox: TeamInboxStore;
  relayService: RelayService;
  /** Fan-out for a new needs-you item: chief turn (non-default) + push. */
  notifyNeedsYou: (person: Person, item: TeamInboxItem) => Promise<void>;
  /** Room message hook: @mentions of people create inbox items for exactly those people. */
  handleRoomPersonMentions: (args: {
    groupId: string;
    groupName: string;
    text: string;
    authorPersonId?: string;
  }) => Promise<TeamInboxItem[]>;
}

/** Production relay sender: the messaging gateway provider registry. */
export function createGatewayRelaySender(dataDir: string): RelaySender {
  return {
    async send({ channel, to, text }) {
      let provider;
      try {
        provider = getMessageProvider(channel, dataDir);
      } catch {
        throw new Error(
          `Relay channel "${channel}" is not configured: no messaging provider is registered under that id ` +
            `(for email, register an "email" message provider; for chat gateways, configure the provider's token).`,
        );
      }
      return provider.send(to, text);
    },
  };
}

export function createPeopleService(deps: PeopleServiceDeps): PeopleService {
  const sender = deps.sender ?? createGatewayRelaySender(deps.dataDir);

  const notifyNeedsYou = async (person: Person, item: TeamInboxItem): Promise<void> => {
    // Per-person chief: a notification TURN on the person's chief bot.
    // notifyPersonChief enforces the default-user exemption (the default
    // user keeps the existing global Chief behaviour).
    try {
      await notifyPersonChief(person, item, async ({ chiefBotId, text }) => {
        const runtime = deps.getRuntime();
        const chiefBot = deps.getBots().find((b) => b.id === chiefBotId);
        if (!runtime || !chiefBot) return;
        await runtime.runTurn({ bot: chiefBot, message: text, onEvent: () => {} });
      });
    } catch {
      // Chief notification must never break inbox writes.
    }
    // Push to paired devices (best-effort, content sealed by PushService).
    try {
      const push = deps.getPush?.();
      if (push) {
        const bot = item.botId ? deps.getBots().find((b) => b.id === item.botId) : undefined;
        await push.notify({
          kind: 'needsInput',
          botId: item.botId ?? 'system',
          botName: bot?.name ?? 'KriyaDot',
          title: item.title,
          body: item.summary.slice(0, 300),
        });
      }
    } catch {
      // Push is best-effort.
    }
    if (deps.onNeedsYouExtra) {
      try {
        await deps.onNeedsYouExtra(person, item);
      } catch {
        // Observers must never break the flow.
      }
    }
  };

  const relayService = new RelayService({
    people: deps.people,
    inbox: deps.inbox,
    ledger: deps.ledger,
    sender,
    deliverToChat: ({ sessionId, text }) => {
      const runtime = deps.getRuntime();
      if (!runtime) throw new Error('Cannot deliver relay reply: agent runtime is not available');
      runtime.sessionStore.appendMessage(sessionId, { role: 'user', content: text });
    },
    onNeedsYou: notifyNeedsYou,
  });

  const handleRoomPersonMentions: PeopleService['handleRoomPersonMentions'] = async ({
    groupId,
    groupName,
    text,
    authorPersonId,
  }) => {
    const mentioned = parsePersonMentions(text, deps.people.listPeople()).filter(
      (p) => p.id !== authorPersonId,
    );
    const created: TeamInboxItem[] = [];
    for (const person of mentioned) {
      const item = deps.inbox.addItem({
        personId: person.id,
        kind: 'mention',
        state: 'needs-you',
        title: `Mentioned in ${groupName}`,
        summary: text.slice(0, 1000),
        groupId,
      });
      created.push(item);
      await notifyNeedsYou(person, item);
      try {
        deps.governance.audit('people.mention', {
          actor: authorPersonId ?? DEFAULT_PERSON_ID,
          detail: { groupId, mentionedPersonId: person.id, itemId: item.id },
        });
      } catch {
        // Audit must never break room turns.
      }
    }
    return created;
  };

  return { people: deps.people, inbox: deps.inbox, relayService, notifyNeedsYou, handleRoomPersonMentions };
}

/** True when <dataDir>/bot-owners.json exists (diagnostics/tests). */
export function botOwnersFileExists(dataDir: string): boolean {
  return existsSync(join(dataDir, OWNERS_FILE));
}
