// SPDX-License-Identifier: Apache-2.0
// Phone data tools (OpenMausBot §1.5): bots read calendar / contacts /
// recent messages / location from the user's OWN paired phone.
//
// Channel: the existing phone WebSocket (phone.ts PhoneSessionHub) IS
// request/response capable for this — dispatchAction already correlates
// an id with an ack. dispatchDataQuery reuses that correlation with wire
// messages { type:'data_query', id, query, params } →
// { type:'data_result', id, ok, error?, data? } (data capped at 256KB in
// validateMessage). The Android phone-agent answers from
// PhoneDataHandlers.kt behind its runtime permissions.
//
// Governance: reading a phone's calendar/contacts/messages/location is
// sensitive personal data, so — matching the other phone tools — every
// tool here is require-approval via phoneDataPolicyRules(). The tools are
// read-only (mutating stays unset): they change nothing on the phone.

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import type { PhoneActionResult, PhoneDataQueryName, PhoneSessionHub } from './phone.js';
import type { PhoneStore } from './phone.js';
import { PAUSED_MESSAGE } from './system-pause.js';

export const PHONE_DATA_TOOL_NAMES = [
  'phone_calendar',
  'phone_contacts',
  'phone_messages_recent',
  'phone_location',
] as const;
export type PhoneDataToolName = (typeof PHONE_DATA_TOOL_NAMES)[number];

const QUERY_BY_TOOL: Record<PhoneDataToolName, PhoneDataQueryName> = {
  phone_calendar: 'calendar',
  phone_contacts: 'contacts',
  phone_messages_recent: 'messages_recent',
  phone_location: 'location',
};

/** Governance: every phone data read needs human approval (privacy). */
export function phoneDataPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'phone-data-approval',
      toolPattern: '^phone_(calendar|contacts|messages_recent|location)$',
      effect: 'require-approval',
      reason:
        'Reading calendar, contacts, recent messages or location from the user\'s paired phone exposes personal data; needs human approval. The approval card shows the exact query.',
    },
  ];
}

export interface PhoneDataDispatcher {
  dispatchDataQuery(
    deviceId: string,
    query: PhoneDataQueryName,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<PhoneActionResult>;
  isOnline(deviceId: string): boolean;
}

/** Production dispatcher: the session hub + the pairing store's device list. */
export function createHubPhoneDataDispatcher(hub: PhoneSessionHub, store: PhoneStore): {
  dispatcher: PhoneDataDispatcher;
  resolveDeviceId: (requested?: string) => string | undefined;
} {
  const dispatcher: PhoneDataDispatcher = {
    dispatchDataQuery: (deviceId, query, params, timeoutMs) => hub.dispatchDataQuery(deviceId, query, params, timeoutMs),
    isOnline: (deviceId) => hub.isOnline(deviceId),
  };
  const resolveDeviceId = (requested?: string): string | undefined => {
    if (requested) return requested;
    return store.listDevices().find((d) => hub.isOnline(d.id))?.id;
  };
  return { dispatcher, resolveDeviceId };
}

function optDeviceId(args: Record<string, unknown>): string | undefined {
  const v = args['deviceId'];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 128 || !/^[A-Za-z0-9_:-]+$/.test(v)) throw new Error('"deviceId" is invalid');
  return v;
}

function boundedInt(args: Record<string, unknown>, name: string, def: number, min: number, max: number): number {
  const v = args[name];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${name}" must be a number`);
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function optQuery(args: Record<string, unknown>): string | undefined {
  const v = args['query'];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 100) throw new Error('"query" must be a string (max 100 chars)');
  return v.trim();
}

/** Validate + normalize params for one data tool. Pure; throws clean errors. */
export function validatePhoneDataQuery(toolName: string, args: Record<string, unknown>): { query: PhoneDataQueryName; params: Record<string, unknown>; deviceId?: string } {
  const query = QUERY_BY_TOOL[toolName as PhoneDataToolName];
  if (!query) throw new Error(`unknown phone data tool "${toolName}"`);
  const deviceId = optDeviceId(args);
  switch (toolName as PhoneDataToolName) {
    case 'phone_calendar':
      return { query, params: { daysAhead: boundedInt(args, 'daysAhead', 7, 1, 31), limit: boundedInt(args, 'limit', 50, 1, 200) }, deviceId };
    case 'phone_contacts': {
      const q = optQuery(args);
      return { query, params: { ...(q ? { query: q } : {}), limit: boundedInt(args, 'limit', 50, 1, 200) }, deviceId };
    }
    case 'phone_messages_recent':
      return { query, params: { limit: boundedInt(args, 'limit', 20, 1, 100) }, deviceId };
    case 'phone_location':
      return { query, params: {}, deviceId };
  }
}

const SPECS: Record<PhoneDataToolName, { description: string; properties: Record<string, unknown> }> = {
  phone_calendar: {
    description: 'Read upcoming calendar events from the user\'s paired phone. Requires human approval (personal data).',
    properties: {
      daysAhead: { type: 'number', description: 'How many days ahead to look (1-31, default 7)' },
      limit: { type: 'number', description: 'Max events (1-200, default 50)' },
      deviceId: { type: 'string', description: 'Paired device id (optional; defaults to the online phone)' },
    },
  },
  phone_contacts: {
    description: 'Search/list contacts on the user\'s paired phone. Requires human approval (personal data).',
    properties: {
      query: { type: 'string', description: 'Optional name search text' },
      limit: { type: 'number', description: 'Max contacts (1-200, default 50)' },
      deviceId: { type: 'string', description: 'Paired device id (optional)' },
    },
  },
  phone_messages_recent: {
    description: 'Read the most recent SMS messages on the user\'s paired phone. Requires human approval (personal data).',
    properties: {
      limit: { type: 'number', description: 'Max messages (1-100, default 20)' },
      deviceId: { type: 'string', description: 'Paired device id (optional)' },
    },
  },
  phone_location: {
    description: 'Get the current (last known / freshly requested) location of the user\'s paired phone. Requires human approval (personal data).',
    properties: {
      deviceId: { type: 'string', description: 'Paired device id (optional)' },
    },
  },
};

export interface PhoneDataToolDeps {
  dispatcher: PhoneDataDispatcher;
  resolveDeviceId?: (requested?: string) => string | undefined;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown; sessionId?: string }) => void;
  isPaused?: () => boolean;
  timeoutMs?: number;
}

export function createPhoneDataTools(deps: PhoneDataToolDeps): ToolDefinition[] {
  return PHONE_DATA_TOOL_NAMES.map((name) => {
    const spec = SPECS[name];
    return {
      name,
      description: spec.description,
      parameters: { type: 'object', properties: spec.properties, required: [], additionalProperties: false },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const validated = validatePhoneDataQuery(name, args);
        if (deps.isPaused?.()) throw new Error(`paused: ${PAUSED_MESSAGE}`);
        const deviceId = validated.deviceId ?? deps.resolveDeviceId?.(undefined);
        if (!deviceId) throw new Error('no paired phone is online — open the Phone tab and connect the phone first');
        if (!deps.dispatcher.isOnline(deviceId)) throw new Error(`phone "${deviceId}" is not connected`);
        const result = await deps.dispatcher.dispatchDataQuery(deviceId, validated.query, validated.params, deps.timeoutMs);
        try {
          // Audit metadata only — never the returned personal data itself.
          deps.audit?.('phone.data_query', {
            actor: ctx.botId, toolName: name, sessionId: ctx.sessionId,
            detail: { query: validated.query, deviceId, ok: result.ok },
          });
        } catch { /* audit must never break the tool */ }
        if (!result.ok) {
          throw new Error(
            result.error === 'timeout'
              ? 'the phone did not answer the data query in time (the phone-agent may be an older build without data-query support)'
              : `phone data query failed: ${result.error ?? 'unknown error'}`,
          );
        }
        return { ok: true, query: validated.query, deviceId, data: result.data ?? null };
      },
    } satisfies ToolDefinition;
  });
}

/** Register the phone data tools into a registry (skips collisions). */
export function registerPhoneDataTools(registry: Map<string, ToolDefinition>, deps: PhoneDataToolDeps): void {
  for (const tool of createPhoneDataTools(deps)) {
    if (!registry.has(tool.name)) registry.set(tool.name, tool);
  }
}
