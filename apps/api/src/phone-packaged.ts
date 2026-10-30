// SPDX-License-Identifier: Apache-2.0
// Packaged phone commands (Muse parity audit §4.14, DV-3): alarms and
// call-history search on the user's OWN paired Android phone.
//
//   phone_set_alarm    { hour, minute, label?, days?, vibrate? }
//                      → dispatchAction 'set_alarm'. The Android phone-agent
//                      answers with AlarmClock.ACTION_SET_ALARM
//                      (EXTRA_SKIP_UI=true), so no clock app is fronted and
//                      no alarm-app permission dance is needed.
//   phone_call_history { query?, type?, limit?, daysBack? }
//                      → dispatchDataQuery 'call_history'. The phone-agent
//                      reads CallLog.Calls behind READ_CALL_LOG and returns
//                      capped, newest-first rows.
//
// Governance (never weakened, matching phone-actions.ts / phone-data-tools.ts):
//   - phone_set_alarm MUTATES device state → require-approval.
//   - phone_call_history reads personal data → require-approval.
// Both rules live in phonePackagedPolicyRules(); the coordinator merges them
// into the bot policy set exactly like the other phone rule sets (see the
// wiring note). Audit entries carry metadata only — never call-log rows.

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import type { PhoneActionResult, PhoneDataQueryName } from './phone.js';
import type { PhoneDataDispatcher } from './phone-data-tools.js';
import { PAUSED_MESSAGE } from './system-pause.js';

/**
 * Action dispatcher for packaged commands. PhoneSessionHub.dispatchAction
 * already accepts an arbitrary action string — the packaged commands ride
 * that exact path (the typed PhoneActionName union in phone-actions.ts
 * covers only the W14 app-operation set).
 */
export interface PackagedActionDispatcher {
  dispatchAction(
    deviceId: string,
    action: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<PhoneActionResult>;
  isOnline(deviceId: string): boolean;
}

export const PHONE_PACKAGED_TOOL_NAMES = ['phone_set_alarm', 'phone_call_history'] as const;
export type PhonePackagedToolName = (typeof PHONE_PACKAGED_TOOL_NAMES)[number];

/** Governance: alarm-setting mutates, call-history reads personal data. */
export function phonePackagedPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'phone-packaged-approval',
      toolPattern: '^phone_(set_alarm|call_history)$',
      effect: 'require-approval',
      reason:
        'Setting an alarm changes state on the user\'s paired phone, and call history is personal data; both need human approval. The approval card shows the exact arguments.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Validation (pure — unit-tested directly)
// ---------------------------------------------------------------------------

function optDeviceId(args: Record<string, unknown>): string | undefined {
  const v = args['deviceId'];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 128 || !/^[A-Za-z0-9_:-]+$/.test(v)) throw new Error('"deviceId" is invalid');
  return v;
}

function reqInt(args: Record<string, unknown>, name: string, min: number, max: number): number {
  const v = args[name];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`"${name}" must be an integer between ${min} and ${max}`);
  }
  return v;
}

function boundedInt(args: Record<string, unknown>, name: string, def: number, min: number, max: number): number {
  const v = args[name];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${name}" must be a number`);
  return Math.max(min, Math.min(max, Math.floor(v)));
}

export interface ValidatedAlarm {
  action: 'set_alarm';
  params: Record<string, unknown>;
  deviceId?: string;
  auditLabel: string;
}

/** Validate phone_set_alarm args. `days` uses Android Calendar DAY_OF_WEEK numbering (1=Sunday … 7=Saturday). */
export function validateSetAlarm(args: Record<string, unknown>): ValidatedAlarm {
  const hour = reqInt(args, 'hour', 0, 23);
  const minute = reqInt(args, 'minute', 0, 59);
  const params: Record<string, unknown> = { hour, minute, skipUi: true };
  const label = args['label'];
  if (label !== undefined && label !== null && label !== '') {
    if (typeof label !== 'string' || label.length > 80) throw new Error('"label" must be a string (max 80 chars)');
    params['label'] = label.trim();
  }
  const days = args['days'];
  if (days !== undefined && days !== null) {
    if (!Array.isArray(days) || days.length === 0 || days.length > 7) {
      throw new Error('"days" must be an array of 1-7 weekday numbers (1=Sunday … 7=Saturday)');
    }
    const seen = new Set<number>();
    for (const d of days) {
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 7) {
        throw new Error('"days" entries must be integers 1 (Sunday) … 7 (Saturday)');
      }
      seen.add(d);
    }
    params['days'] = [...seen].sort((a, b) => a - b);
  }
  if (args['vibrate'] !== undefined && args['vibrate'] !== null) {
    if (typeof args['vibrate'] !== 'boolean') throw new Error('"vibrate" must be a boolean');
    params['vibrate'] = args['vibrate'];
  }
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return {
    action: 'set_alarm',
    params,
    deviceId: optDeviceId(args),
    auditLabel: `Set an alarm for ${hh}:${mm}${typeof params['label'] === 'string' ? ` ("${params['label']}")` : ''} on the phone`,
  };
}

export const CALL_HISTORY_TYPES = ['all', 'incoming', 'outgoing', 'missed', 'rejected', 'blocked'] as const;
export type CallHistoryType = (typeof CALL_HISTORY_TYPES)[number];

export interface ValidatedCallHistory {
  query: 'call_history';
  params: Record<string, unknown>;
  deviceId?: string;
}

/** Validate phone_call_history args. */
export function validateCallHistory(args: Record<string, unknown>): ValidatedCallHistory {
  const params: Record<string, unknown> = {
    limit: boundedInt(args, 'limit', 30, 1, 200),
    daysBack: boundedInt(args, 'daysBack', 30, 1, 365),
  };
  const q = args['query'];
  if (q !== undefined && q !== null && q !== '') {
    if (typeof q !== 'string' || q.length > 100) throw new Error('"query" must be a string (max 100 chars)');
    params['query'] = q.trim();
  }
  const type = args['type'];
  if (type !== undefined && type !== null && type !== '') {
    if (typeof type !== 'string' || !(CALL_HISTORY_TYPES as readonly string[]).includes(type)) {
      throw new Error(`"type" must be one of ${CALL_HISTORY_TYPES.join(' | ')}`);
    }
    if (type !== 'all') params['type'] = type;
  }
  return { query: 'call_history', params, deviceId: optDeviceId(args) };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface PhonePackagedToolDeps {
  actionDispatcher: PackagedActionDispatcher;
  dataDispatcher: PhoneDataDispatcher;
  resolveDeviceId?: (requested?: string) => string | undefined;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown; sessionId?: string }) => void;
  isPaused?: () => boolean;
  timeoutMs?: number;
}

function resolveOnline(deps: PhonePackagedToolDeps, isOnline: (id: string) => boolean, requested?: string): string {
  const deviceId = requested ?? deps.resolveDeviceId?.(undefined);
  if (!deviceId) throw new Error('no paired phone is online — open the Phone tab and connect the phone first');
  if (!isOnline(deviceId)) throw new Error(`phone "${deviceId}" is not connected`);
  return deviceId;
}

export function createPhonePackagedTools(deps: PhonePackagedToolDeps): ToolDefinition[] {
  const alarm: ToolDefinition = {
    name: 'phone_set_alarm',
    description:
      'Set an alarm on the user\'s paired Android phone (packaged command; the phone-agent uses the system AlarmClock intent, no app is fronted). Requires human approval.',
    parameters: {
      type: 'object',
      properties: {
        hour: { type: 'number', description: 'Hour 0-23' },
        minute: { type: 'number', description: 'Minute 0-59' },
        label: { type: 'string', description: 'Optional alarm label (max 80 chars)' },
        days: { type: 'array', items: { type: 'number' }, description: 'Optional repeat weekdays, 1=Sunday … 7=Saturday. Omit for a one-shot alarm.' },
        vibrate: { type: 'boolean', description: 'Optional vibrate flag' },
        deviceId: { type: 'string', description: 'Paired device id (optional; defaults to the online phone)' },
      },
      required: ['hour', 'minute'],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext) => {
      const v = validateSetAlarm(args);
      if (deps.isPaused?.()) throw new Error(`paused: ${PAUSED_MESSAGE}`);
      const deviceId = resolveOnline(deps, (id) => deps.actionDispatcher.isOnline(id), v.deviceId);
      const result = await deps.actionDispatcher.dispatchAction(deviceId, v.action, v.params, deps.timeoutMs);
      try {
        deps.audit?.('phone.packaged_command', {
          actor: ctx.botId, toolName: 'phone_set_alarm', sessionId: ctx.sessionId,
          detail: { command: 'set_alarm', deviceId, ok: result.ok, label: v.auditLabel },
        });
      } catch { /* audit must never break the tool */ }
      if (!result.ok) {
        throw new Error(
          result.error === 'timeout'
            ? 'the phone did not ack the alarm command in time (the phone-agent may be an older build without packaged-command support)'
            : `phone alarm command failed: ${result.error ?? 'unknown error'}`,
        );
      }
      return { ok: true, command: 'set_alarm', deviceId, alarm: v.params };
    },
  };

  const history: ToolDefinition = {
    name: 'phone_call_history',
    description:
      'Search the call history on the user\'s paired Android phone (by name/number text, call type, recency). Read-only. Requires human approval (personal data).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional name or number search text' },
        type: { type: 'string', enum: [...CALL_HISTORY_TYPES], description: 'Optional call-type filter (default all)' },
        limit: { type: 'number', description: 'Max rows (1-200, default 30)' },
        daysBack: { type: 'number', description: 'Only calls within this many days (1-365, default 30)' },
        deviceId: { type: 'string', description: 'Paired device id (optional)' },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext) => {
      const v = validateCallHistory(args);
      if (deps.isPaused?.()) throw new Error(`paused: ${PAUSED_MESSAGE}`);
      const deviceId = resolveOnline(deps, (id) => deps.dataDispatcher.isOnline(id), v.deviceId);
      // 'call_history' rides the hub's string-typed query path (the typed
      // union in phone.ts covers the original four queries).
      const result = await deps.dataDispatcher.dispatchDataQuery(deviceId, v.query as PhoneDataQueryName, v.params, deps.timeoutMs);
      try {
        // Audit metadata only — never the returned call rows.
        deps.audit?.('phone.packaged_command', {
          actor: ctx.botId, toolName: 'phone_call_history', sessionId: ctx.sessionId,
          detail: { command: 'call_history', deviceId, ok: result.ok },
        });
      } catch { /* audit must never break the tool */ }
      if (!result.ok) {
        throw new Error(
          result.error === 'timeout'
            ? 'the phone did not answer the call-history query in time (the phone-agent may be an older build without packaged-command support)'
            : `phone call-history query failed: ${result.error ?? 'unknown error'}`,
        );
      }
      return { ok: true, query: 'call_history', deviceId, data: result.data ?? null };
    },
  };

  return [alarm, history];
}

/** Register the packaged phone tools into a registry (skips collisions). */
export function registerPhonePackagedTools(registry: Map<string, ToolDefinition>, deps: PhonePackagedToolDeps): void {
  for (const tool of createPhonePackagedTools(deps)) {
    if (!registry.has(tool.name)) registry.set(tool.name, tool);
  }
}
