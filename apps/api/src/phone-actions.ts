// SPDX-License-Identifier: Apache-2.0
// Phone-app operation tools (W14a): bots operate third-party apps on the
// user's OWN paired phone through the phone-agent accessibility service.
//
// Tools (all MUTATING, all require-approval via phoneActionPolicyRules):
//   phone_open_app     { packageName, deviceId? }
//   phone_tap          { x, y } | { text }            (coords 0..1 or label)
//   phone_type         { text }                       (into the focused field)
//   phone_scroll       { direction, amount? }
//   phone_send_message { contact, text, app? }        (WhatsApp/SMS)
//   phone_send_file    { contact, fileName, contentBase64, mimeType?, caption? }
//                                                     (WhatsApp share sheet, ADD-5)
//   phone_call         { number, contact? }
//
// Governance + safety contract (never weakened):
//   - Governance evaluates BEFORE the handler runs (the runtime does this
//     for every tool), and the policy rules below force require-approval
//     for every phone_* action tool — a denied/unapproved call never
//     reaches dispatch, so nothing is sent to the phone.
//   - The handler dispatches exactly the approved arguments over the
//     existing phone WebSocket (PhoneSessionHub.dispatchAction, wire
//     message { type:'action', id, action, params }) and awaits the
//     phone's ack with a timeout.
//   - Global pause (W14d) refuses dispatch before anything is sent.
//   - Every dispatched action writes ONE plain-language audit entry
//     (e.g. "Opened WhatsApp", "Sent message to <contact name>"). Message
//     bodies and typed text are NEVER written to audit — the audit holds
//     the action + the contact NAME only.

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import type { PhoneActionResult, PhoneSessionHub } from './phone.js';
import type { PhoneStore } from './phone.js';
import { PAUSED_MESSAGE } from './system-pause.js';

export type PhoneActionName =
  | 'open_app'
  | 'tap'
  | 'type'
  | 'scroll'
  | 'send_message'
  | 'send_file'
  | 'call';

export const PHONE_ACTION_TOOL_NAMES = [
  'phone_open_app',
  'phone_tap',
  'phone_type',
  'phone_scroll',
  'phone_send_message',
  'phone_send_file',
  'phone_call',
] as const;

/** Governance: every phone-app action is mutating → human approval first. */
export function phoneActionPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'phone-actions-approval',
      toolPattern: '^phone_(open_app|tap|type|scroll|send_message|send_file|call)$',
      effect: 'require-approval',
      reason:
        'Operating apps on the user\'s paired phone (opening apps, tapping, typing, sending messages and files, calling) changes state on a personal device; needs human approval. The approval card shows the exact action arguments.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Dispatcher abstraction (the hub in production; a mock in tests)
// ---------------------------------------------------------------------------

export interface PhoneActionDispatcher {
  dispatchAction(
    deviceId: string,
    action: PhoneActionName,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<PhoneActionResult>;
  isOnline(deviceId: string): boolean;
}

/** Production dispatcher: the session hub + the pairing store's device list. */
export function createHubPhoneActionDispatcher(hub: PhoneSessionHub, store: PhoneStore): {
  dispatcher: PhoneActionDispatcher;
  resolveDeviceId: (requested?: string) => string | undefined;
} {
  const dispatcher: PhoneActionDispatcher = {
    dispatchAction: (deviceId, action, params, timeoutMs) =>
      hub.dispatchAction(deviceId, action, params, timeoutMs),
    isOnline: (deviceId) => hub.isOnline(deviceId),
  };
  const resolveDeviceId = (requested?: string): string | undefined => {
    if (requested) return requested;
    // Default: the first paired device that is currently online.
    return store.listDevices().find((d) => hub.isOnline(d.id))?.id;
  };
  return { dispatcher, resolveDeviceId };
}

// ---------------------------------------------------------------------------
// Validation (pure — unit-tested directly)
// ---------------------------------------------------------------------------

export interface ValidatedPhoneAction {
  action: PhoneActionName;
  params: Record<string, unknown>;
  deviceId?: string;
  /** Plain-language audit label. NEVER contains message/typed text. */
  auditLabel: string;
  /** Contact name for send_message/call, when supplied (audit-safe). */
  contactName?: string;
}

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PHONE_NUMBER_RE = /^\+?[0-9][0-9 ()-]{4,24}$/;
export const MAX_PHONE_TEXT_LEN = 1024;
/**
 * Phone file-send ceiling (ADD-5): the bytes travel inside the action
 * WebSocket message as base64, so the cap is deliberately modest — 5 MB
 * of file content (≈6.7 MB of base64). Bigger files belong on the
 * WhatsApp Cloud path (16 MB upload) or a link.
 */
export const MAX_PHONE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_PHONE_FILE_BASE64_LEN = Math.ceil(MAX_PHONE_FILE_BYTES / 3) * 4 + 4;

function reqString(args: Record<string, unknown>, name: string, max: number): string {
  const v = args[name];
  if (typeof v !== 'string' || !v.trim() || v.length > max) {
    throw new Error(`"${name}" is required (non-empty string, max ${max} chars)`);
  }
  return v.trim();
}

function optDeviceId(args: Record<string, unknown>): string | undefined {
  const v = args['deviceId'];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 128 || !/^[A-Za-z0-9_:-]+$/.test(v)) {
    throw new Error('"deviceId" is invalid');
  }
  return v;
}

function unit(args: Record<string, unknown>, name: string): number {
  const v = args[name];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`"${name}" must be a number between 0 and 1`);
  }
  return v;
}

/** Friendly app label for audit ("com.whatsapp" → "WhatsApp"). */
export function appLabelFor(packageName: string): string {
  const last = packageName.split('.').pop() ?? packageName;
  if (/whatsapp/i.test(packageName)) return 'WhatsApp';
  if (/mms|messaging|sms/i.test(packageName)) return 'Messages';
  return last.charAt(0).toUpperCase() + last.slice(1);
}

export const MESSAGING_APP_PACKAGES: Record<string, string> = {
  whatsapp: 'com.whatsapp',
  sms: 'com.google.android.apps.messaging',
};

/** Validate + normalize one tool call. Throws Error with a clean message. */
export function validatePhoneAction(
  toolName: string,
  args: Record<string, unknown>,
): ValidatedPhoneAction {
  const deviceId = optDeviceId(args);
  switch (toolName) {
    case 'phone_open_app': {
      const packageName = reqString(args, 'packageName', 128);
      if (!PACKAGE_RE.test(packageName)) throw new Error('"packageName" must be an Android package name (e.g. "com.whatsapp")');
      return {
        action: 'open_app',
        params: { packageName },
        deviceId,
        auditLabel: `Opened ${appLabelFor(packageName)}`,
      };
    }
    case 'phone_tap': {
      const hasCoords = args['x'] !== undefined || args['y'] !== undefined;
      const hasText = typeof args['text'] === 'string' && (args['text'] as string).trim().length > 0;
      if (hasCoords && hasText) throw new Error('pass either coordinates (x, y) or "text", not both');
      if (hasText) {
        const text = reqString(args, 'text', 100);
        return { action: 'tap', params: { text }, deviceId, auditLabel: `Tapped "${text}" on the phone` };
      }
      if (hasCoords) {
        const x = unit(args, 'x');
        const y = unit(args, 'y');
        return { action: 'tap', params: { x, y }, deviceId, auditLabel: 'Tapped on the phone' };
      }
      throw new Error('phone_tap needs coordinates (x, y) or a visible "text" label to tap');
    }
    case 'phone_type': {
      const text = reqString(args, 'text', MAX_PHONE_TEXT_LEN);
      // The text itself goes to the phone only — never into the audit label.
      return { action: 'type', params: { text }, deviceId, auditLabel: 'Typed text on the phone' };
    }
    case 'phone_scroll': {
      const direction = args['direction'];
      if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
        throw new Error('"direction" must be one of up | down | left | right');
      }
      let amount = 0.6;
      if (args['amount'] !== undefined) {
        if (typeof args['amount'] !== 'number' || !Number.isFinite(args['amount']) || args['amount'] <= 0 || args['amount'] > 1) {
          throw new Error('"amount" must be a number between 0 and 1');
        }
        amount = args['amount'];
      }
      return {
        action: 'scroll',
        params: { direction, amount },
        deviceId,
        auditLabel: `Scrolled ${direction} on the phone`,
      };
    }
    case 'phone_send_message': {
      const contact = reqString(args, 'contact', 100);
      const text = reqString(args, 'text', MAX_PHONE_TEXT_LEN);
      const appRaw = typeof args['app'] === 'string' ? (args['app'] as string).trim().toLowerCase() : 'whatsapp';
      const packageName = MESSAGING_APP_PACKAGES[appRaw];
      if (!packageName) throw new Error('"app" must be "whatsapp" or "sms"');
      return {
        action: 'send_message',
        // The exact approved text travels in params to the phone only.
        params: { app: appRaw, packageName, contact, text },
        deviceId,
        auditLabel: `Sent message to ${contact}`,
        contactName: contact,
      };
    }
    case 'phone_send_file': {
      const contact = reqString(args, 'contact', 100);
      const fileName = reqString(args, 'fileName', 200);
      // The name becomes a file name on the phone — no paths, no tricks.
      if (/[/\\]/.test(fileName) || fileName === '.' || fileName === '..' || fileName.includes('\0')) {
        throw new Error('"fileName" must be a plain file name (no path separators)');
      }
      const contentBase64 = args['contentBase64'];
      if (typeof contentBase64 !== 'string' || contentBase64.length === 0) {
        throw new Error('"contentBase64" is required (the file bytes, base64-encoded)');
      }
      if (contentBase64.length > MAX_PHONE_FILE_BASE64_LEN || !/^[A-Za-z0-9+/=\s]+$/.test(contentBase64)) {
        throw new Error(`"contentBase64" must be valid base64 of at most ${MAX_PHONE_FILE_BYTES} bytes of file content`);
      }
      const byteLength = Buffer.from(contentBase64, 'base64').length;
      if (byteLength === 0 || byteLength > MAX_PHONE_FILE_BYTES) {
        throw new Error(`file must be between 1 byte and ${MAX_PHONE_FILE_BYTES} bytes`);
      }
      let mimeType = 'application/octet-stream';
      if (args['mimeType'] !== undefined) {
        if (typeof args['mimeType'] !== 'string' || args['mimeType'].length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(args['mimeType'])) {
          throw new Error('"mimeType" must look like "application/pdf"');
        }
        mimeType = args['mimeType'];
      }
      const caption = typeof args['caption'] === 'string' && (args['caption'] as string).trim()
        ? (args['caption'] as string).trim().slice(0, MAX_PHONE_TEXT_LEN)
        : undefined;
      return {
        action: 'send_file',
        // The exact approved bytes travel in params to the phone only —
        // the audit label below carries the file NAME and contact, never
        // the content.
        params: {
          packageName: MESSAGING_APP_PACKAGES['whatsapp'],
          contact,
          fileName,
          mimeType,
          contentBase64,
          ...(caption ? { caption } : {}),
        },
        deviceId,
        auditLabel: `Sent file ${fileName} to ${contact}`,
        contactName: contact,
      };
    }
    case 'phone_call': {
      const number = reqString(args, 'number', 32);
      if (!PHONE_NUMBER_RE.test(number)) throw new Error('"number" must be a phone number (digits, optional leading +)');
      const contact = typeof args['contact'] === 'string' && (args['contact'] as string).trim()
        ? (args['contact'] as string).trim().slice(0, 100)
        : undefined;
      return {
        action: 'call',
        params: { number, ...(contact ? { contact } : {}) },
        deviceId,
        // Audit names the contact when known; the number itself is not logged.
        auditLabel: contact ? `Called ${contact}` : 'Placed a phone call',
        ...(contact ? { contactName: contact } : {}),
      };
    }
    default:
      throw new Error(`unknown phone action tool "${toolName}"`);
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface PhoneActionToolDeps {
  dispatcher: PhoneActionDispatcher;
  /** Resolve the target device: explicit arg → this resolver → error. */
  resolveDeviceId?: (requested?: string) => string | undefined;
  /** Plain-language audit sink (host governance.audit). */
  audit?: (
    action: string,
    fields: { actor?: string; toolName?: string; detail?: unknown; sessionId?: string },
  ) => void;
  /** Global pause gate (W14d). */
  isPaused?: () => boolean;
  /** Ack timeout override (tests). */
  timeoutMs?: number;
}

const TOOL_DESCRIPTIONS: Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> = {
  phone_open_app: {
    description: 'Open an app on the user\'s paired phone by Android package name (e.g. "com.whatsapp"). Requires human approval.',
    properties: {
      packageName: { type: 'string', description: 'Android package name, e.g. "com.whatsapp"' },
      deviceId: { type: 'string', description: 'Paired device id (optional; defaults to the online phone)' },
    },
    required: ['packageName'],
  },
  phone_tap: {
    description: 'Tap on the user\'s paired phone: either normalized coordinates (x, y in 0..1) or the visible text label of the element to tap. Requires human approval.',
    properties: {
      x: { type: 'number', description: 'Normalized x coordinate (0..1)' },
      y: { type: 'number', description: 'Normalized y coordinate (0..1)' },
      text: { type: 'string', description: 'Visible label text to find and tap' },
      deviceId: { type: 'string', description: 'Paired device id (optional)' },
    },
    required: [],
  },
  phone_type: {
    description: 'Type text into the currently focused field on the user\'s paired phone. Requires human approval.',
    properties: {
      text: { type: 'string', description: 'Text to type (max 1024 chars)' },
      deviceId: { type: 'string', description: 'Paired device id (optional)' },
    },
    required: ['text'],
  },
  phone_scroll: {
    description: 'Scroll on the user\'s paired phone in a direction. Requires human approval.',
    properties: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number', description: 'Scroll distance as a fraction of the screen (0..1, default 0.6)' },
      deviceId: { type: 'string', description: 'Paired device id (optional)' },
    },
    required: ['direction'],
  },
  phone_send_message: {
    description:
      'Send a message on the user\'s paired phone: opens the messaging app (WhatsApp or SMS) at the conversation with the named contact and sends EXACTLY the approved text. Requires human approval — the approval card shows the contact and the full text.',
    properties: {
      contact: { type: 'string', description: 'Contact name as shown in the messaging app' },
      text: { type: 'string', description: 'The exact message text to send (max 1024 chars)' },
      app: { type: 'string', enum: ['whatsapp', 'sms'], description: 'Messaging app (default whatsapp)' },
      deviceId: { type: 'string', description: 'Paired device id (optional)' },
    },
    required: ['contact', 'text'],
  },
  phone_send_file: {
    description:
      'Send a FILE to a WhatsApp contact from the user\'s paired phone: the phone agent saves the approved bytes on the phone, opens WhatsApp\'s share sheet with the file attached, picks the contact and taps Send. Requires human approval — the approval card shows the contact and the file name. Max 5 MB.',
    properties: {
      contact: { type: 'string', description: 'Contact name as shown in WhatsApp' },
      fileName: { type: 'string', description: 'Plain file name, e.g. "report.pdf" (no path separators)' },
      contentBase64: { type: 'string', description: 'The file bytes, base64-encoded (max 5 MB of content)' },
      mimeType: { type: 'string', description: 'MIME type, e.g. "application/pdf" (default application/octet-stream)' },
      caption: { type: 'string', description: 'Optional caption sent with the file' },
      deviceId: { type: 'string', description: 'Paired device id (optional)' },
    },
    required: ['contact', 'fileName', 'contentBase64'],
  },
  phone_call: {
    description: 'Place a phone call from the user\'s paired phone to the given number. Requires human approval.',
    properties: {
      number: { type: 'string', description: 'Phone number to call' },
      contact: { type: 'string', description: 'Contact name (used for the audit label, optional)' },
      deviceId: { type: 'string', description: 'Paired device id (optional)' },
    },
    required: ['number'],
  },
};

export function createPhoneActionTools(deps: PhoneActionToolDeps): ToolDefinition[] {
  return PHONE_ACTION_TOOL_NAMES.map((name) => {
    const spec = TOOL_DESCRIPTIONS[name]!;
    const tool: ToolDefinition = {
      name,
      mutating: true,
      description: spec.description,
      parameters: {
        type: 'object',
        properties: spec.properties,
        required: spec.required,
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        // Validation first: malformed calls fail before any dispatch.
        const validated = validatePhoneAction(name, args);
        if (deps.isPaused?.()) {
          throw new Error(`paused: ${PAUSED_MESSAGE}`);
        }
        const deviceId = validated.deviceId ?? deps.resolveDeviceId?.(undefined);
        if (!deviceId) {
          throw new Error('no paired phone is online — open the Phone tab and connect the phone first');
        }
        if (!deps.dispatcher.isOnline(deviceId)) {
          throw new Error(`phone "${deviceId}" is not connected`);
        }
        const result = await deps.dispatcher.dispatchAction(
          deviceId,
          validated.action,
          validated.params,
          deps.timeoutMs,
        );
        // Plain-language audit for EVERY dispatched action — success or
        // failure. Contact NAME is included; message/typed text never is.
        try {
          deps.audit?.('phone.action', {
            actor: ctx.botId,
            toolName: name,
            sessionId: ctx.sessionId,
            detail: {
              label: validated.auditLabel,
              action: validated.action,
              deviceId,
              ok: result.ok,
              ...(validated.contactName ? { contact: validated.contactName } : {}),
              ...(result.ok ? {} : { error: result.error ?? 'action_failed' }),
            },
          });
        } catch {
          // Audit must never break the tool.
        }
        if (!result.ok) {
          throw new Error(
            result.error === 'timeout'
              ? 'the phone did not acknowledge the action in time'
              : `phone action failed: ${result.error ?? 'unknown error'}`,
          );
        }
        return { ok: true, action: validated.action, deviceId, label: validated.auditLabel };
      },
    };
    return tool;
  });
}

/** Register the phone-action tools into a registry (skips collisions). */
export function registerPhoneActionTools(
  registry: Map<string, ToolDefinition>,
  deps: PhoneActionToolDeps,
): void {
  for (const tool of createPhoneActionTools(deps)) {
    if (!registry.has(tool.name)) registry.set(tool.name, tool);
  }
}
