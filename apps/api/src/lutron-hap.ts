// SPDX-License-Identifier: Apache-2.0
// Lutron lighting + shades via HAP (HomeKit Accessory Protocol)
// (Muse parity audit §4.14, DV-14).
//
// Lutron's Caséta Smart Bridge and RA2 Select / RadioRA 3 processors expose
// their loads to Apple HomeKit; HAP is the protocol on the wire. This module
// implements the HAP *client shape* for accessory control behind an
// injectable transport:
//
//   GET  /accessories     → the accessory database (services/characteristics)
//   PUT  /characteristics → write characteristic values (on, brightness,
//                           target position for shades)
//
// The transport represents an ALREADY-PAIRED, encrypted HAP session
// (http+ChaCha20-Poly1305 framing after pair-verify). Live pairing itself —
// SRP-6a pair-setup with the bridge's 8-digit setup code, Ed25519 identity
// keys, and the encrypted session handshake — is HARDWARE-GATED: it needs
// the physical bridge + its setup code in hand and cannot be exercised or
// verified in this environment. `pairSetup()` therefore refuses honestly
// instead of pretending. Everything above the session (accessory parsing,
// Lutron load mapping, characteristic writes) is implemented and
// mock-verified here.
//
// Governance: writing characteristics controls physical lights/shades →
// require-approval via lutronHapPolicyRules().

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import { PAUSED_MESSAGE } from './system-pause.js';

export function lutronHapPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'lutron-hap-approval',
      toolPattern: '^lutron_control$',
      effect: 'require-approval',
      reason:
        'Controlling lights and shades through the Lutron bridge (HAP) changes the physical home; needs human approval.',
    },
  ];
}

// ---------------------------------------------------------------------------
// HAP model
// ---------------------------------------------------------------------------

/** HAP service/characteristic type UUIDs (short forms, as bridges return them). */
export const HAP_TYPE = {
  service: {
    lightbulb: '43',
    switch: '49',
    windowCovering: '8C',
    accessoryInfo: '3E',
  },
  characteristic: {
    on: '25',
    brightness: '08',
    name: '23',
    currentPosition: '6D',
    targetPosition: '7C',
    positionState: '72',
  },
} as const;

export interface HapCharacteristic {
  aid: number;
  iid: number;
  type: string;
  value?: unknown;
  format?: string;
  perms?: string[];
}

export interface HapService {
  iid: number;
  type: string;
  characteristics: HapCharacteristic[];
}

export interface HapAccessory {
  aid: number;
  services: HapService[];
}

export interface HapRequest {
  method: 'GET' | 'PUT' | 'POST';
  path: string;
  body?: unknown;
}

export interface HapResponse {
  status: number;
  body: unknown;
}

/** An established (paired + encrypted) HAP session. Hardware-gated in production. */
export type HapTransport = (req: HapRequest) => Promise<HapResponse>;

export class HapError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'HapError';
  }
}

export class HapPairingError extends HapError {
  constructor() {
    super(
      'HAP pairing is hardware-gated: pair-setup (SRP-6a + Ed25519 identity exchange) must run against the physical Lutron bridge with its 8-digit HomeKit setup code, and the encrypted session it produces cannot be created or verified in this environment. ' +
        'This client implements everything above an established session (accessory reads + characteristic writes); live pairing is unverified by design.',
    );
    this.name = 'HapPairingError';
  }
}

export class HapClient {
  constructor(private readonly transport: HapTransport) {}

  /** Attempt pairing — always refuses honestly (see module header). */
  async pairSetup(_setupCode: string): Promise<never> {
    throw new HapPairingError();
  }

  async listAccessories(): Promise<HapAccessory[]> {
    const res = await this.transport({ method: 'GET', path: '/accessories' });
    if (res.status < 200 || res.status >= 300) throw new HapError(`GET /accessories failed with HAP status ${res.status}`, res.status);
    const body = res.body as { accessories?: HapAccessory[] } | null;
    if (!body || !Array.isArray(body.accessories)) throw new HapError('GET /accessories returned no accessory database');
    return body.accessories;
  }

  /** Write one characteristic value (PUT /characteristics, HAP §6.7). */
  async setCharacteristic(aid: number, iid: number, value: unknown): Promise<void> {
    const res = await this.transport({
      method: 'PUT',
      path: '/characteristics',
      body: { characteristics: [{ aid, iid, value }] },
    });
    // HAP answers 204 No Content on full success, 207 Multi-Status on partial.
    if (res.status === 207) {
      const statuses = (res.body as { characteristics?: Array<{ status?: number }> } | null)?.characteristics ?? [];
      const bad = statuses.find((s) => typeof s.status === 'number' && s.status !== 0);
      if (bad) throw new HapError(`characteristic write failed with HAP status ${bad.status}`, bad.status);
      return;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new HapError(`PUT /characteristics failed with HAP status ${res.status}`, res.status);
    }
  }
}

// ---------------------------------------------------------------------------
// Lutron load mapping
// ---------------------------------------------------------------------------

export type LutronDeviceKind = 'light' | 'switch' | 'shade';

export interface LutronDevice {
  aid: number;
  name: string;
  kind: LutronDeviceKind;
  on?: boolean;
  brightness?: number;
  /** Shade position 0 (closed) … 100 (open). */
  position?: number;
  /** iid handles for writes. */
  iids: { on?: number; brightness?: number; targetPosition?: number };
}

function charOf(service: HapService, type: string): HapCharacteristic | undefined {
  return service.characteristics.find((c) => c.type.toUpperCase() === type.toUpperCase());
}

function nameOf(accessory: HapAccessory): string {
  for (const s of accessory.services) {
    for (const type of [HAP_TYPE.service.accessoryInfo, HAP_TYPE.service.lightbulb, HAP_TYPE.service.windowCovering, HAP_TYPE.service.switch]) {
      if (s.type.toUpperCase() !== type.toUpperCase()) continue;
      const n = charOf(s, HAP_TYPE.characteristic.name);
      if (typeof n?.value === 'string' && n.value) return n.value;
    }
  }
  return `Accessory ${accessory.aid}`;
}

/** Map a raw HAP accessory database onto Lutron-style loads (pure). */
export function mapLutronDevices(accessories: HapAccessory[]): LutronDevice[] {
  const devices: LutronDevice[] = [];
  for (const acc of accessories) {
    for (const svc of acc.services) {
      const t = svc.type.toUpperCase();
      if (t === HAP_TYPE.service.lightbulb || t === HAP_TYPE.service.switch) {
        const on = charOf(svc, HAP_TYPE.characteristic.on);
        const brightness = charOf(svc, HAP_TYPE.characteristic.brightness);
        devices.push({
          aid: acc.aid,
          name: nameOf(acc),
          kind: t === HAP_TYPE.service.lightbulb ? 'light' : 'switch',
          on: typeof on?.value === 'boolean' ? on.value : on?.value === 1 ? true : on?.value === 0 ? false : undefined,
          brightness: typeof brightness?.value === 'number' ? brightness.value : undefined,
          iids: { on: on?.iid, brightness: brightness?.iid },
        });
      } else if (t === HAP_TYPE.service.windowCovering) {
        const current = charOf(svc, HAP_TYPE.characteristic.currentPosition);
        const target = charOf(svc, HAP_TYPE.characteristic.targetPosition);
        devices.push({
          aid: acc.aid,
          name: nameOf(acc),
          kind: 'shade',
          position: typeof current?.value === 'number' ? current.value : undefined,
          iids: { targetPosition: target?.iid },
        });
      }
    }
  }
  return devices;
}

export class LutronHapBridge {
  constructor(private readonly hap: HapClient) {}

  async devices(): Promise<LutronDevice[]> {
    return mapLutronDevices(await this.hap.listAccessories());
  }

  private async find(aid: number, kind?: LutronDeviceKind): Promise<LutronDevice> {
    const device = (await this.devices()).find((d) => d.aid === aid && (!kind || d.kind === kind));
    if (!device) throw new HapError(`no ${kind ?? 'device'} with aid ${aid} on this bridge`);
    return device;
  }

  async setLight(aid: number, opts: { on?: boolean; brightness?: number }): Promise<void> {
    const device = await this.find(aid, 'light');
    if (opts.on !== undefined) {
      if (device.iids.on === undefined) throw new HapError(`light aid ${aid} has no On characteristic`);
      await this.hap.setCharacteristic(aid, device.iids.on, opts.on);
    }
    if (opts.brightness !== undefined) {
      if (device.iids.brightness === undefined) throw new HapError(`light aid ${aid} is not dimmable (no Brightness characteristic)`);
      const b = Math.max(0, Math.min(100, Math.round(opts.brightness)));
      await this.hap.setCharacteristic(aid, device.iids.brightness, b);
    }
  }

  async setSwitch(aid: number, on: boolean): Promise<void> {
    const device = await this.find(aid, 'switch');
    if (device.iids.on === undefined) throw new HapError(`switch aid ${aid} has no On characteristic`);
    await this.hap.setCharacteristic(aid, device.iids.on, on);
  }

  /** Move a shade to position 0 (closed) … 100 (open). */
  async setShadePosition(aid: number, position: number): Promise<void> {
    const device = await this.find(aid, 'shade');
    if (device.iids.targetPosition === undefined) throw new HapError(`shade aid ${aid} has no TargetPosition characteristic`);
    const p = Math.max(0, Math.min(100, Math.round(position)));
    await this.hap.setCharacteristic(aid, device.iids.targetPosition, p);
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface LutronToolDeps {
  /** Build the bridge per call; the transport factory decides how the paired session is supplied. */
  createBridge: () => LutronHapBridge;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown; sessionId?: string }) => void;
  isPaused?: () => boolean;
}

const LUTRON_ACTIONS = ['list', 'set_light', 'set_switch', 'set_shade'] as const;

export function createLutronHapTools(deps: LutronToolDeps): ToolDefinition[] {
  return [
    {
      name: 'lutron_control',
      description:
        'Control Lutron lights, switches and shades exposed through the bridge\'s HomeKit (HAP) interface: list loads, set light on/brightness, switch on/off, move shades (0=closed, 100=open). Requires human approval. NOTE: controlling requires an already-paired HAP session — live pairing with the physical bridge is hardware-gated and not performed by this tool.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...LUTRON_ACTIONS], description: 'What to do' },
          aid: { type: 'number', description: 'Accessory id from action=list' },
          on: { type: 'boolean', description: 'On/off target (set_light / set_switch)' },
          brightness: { type: 'number', description: 'Brightness 0-100 (set_light)' },
          position: { type: 'number', description: 'Shade position 0 (closed) - 100 (open) (set_shade)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      handler: async (args, ctx: ToolContext) => {
        if (deps.isPaused?.()) throw new Error(`paused: ${PAUSED_MESSAGE}`);
        const action = args['action'];
        if (typeof action !== 'string' || !(LUTRON_ACTIONS as readonly string[]).includes(action)) {
          throw new Error(`"action" must be one of ${LUTRON_ACTIONS.join(' | ')}`);
        }
        const bridge = deps.createBridge();
        const aid = typeof args['aid'] === 'number' ? Math.floor(args['aid']) : undefined;
        let result: unknown;
        switch (action) {
          case 'list':
            result = await bridge.devices();
            break;
          case 'set_light': {
            if (aid === undefined) throw new Error('"aid" is required for set_light');
            await bridge.setLight(aid, {
              on: typeof args['on'] === 'boolean' ? args['on'] : undefined,
              brightness: typeof args['brightness'] === 'number' ? args['brightness'] : undefined,
            });
            result = { ok: true };
            break;
          }
          case 'set_switch': {
            if (aid === undefined || typeof args['on'] !== 'boolean') throw new Error('"aid" and "on" are required for set_switch');
            await bridge.setSwitch(aid, args['on']);
            result = { ok: true };
            break;
          }
          case 'set_shade': {
            if (aid === undefined || typeof args['position'] !== 'number') throw new Error('"aid" and "position" are required for set_shade');
            await bridge.setShadePosition(aid, args['position']);
            result = { ok: true };
            break;
          }
        }
        try {
          deps.audit?.('lutron.control', {
            actor: ctx.botId, toolName: 'lutron_control', sessionId: ctx.sessionId,
            detail: { action, aid },
          });
        } catch { /* audit must never break the tool */ }
        return { ok: true, action, result };
      },
    } satisfies ToolDefinition,
  ];
}

export function registerLutronHapTools(registry: Map<string, ToolDefinition>, deps: LutronToolDeps): void {
  for (const tool of createLutronHapTools(deps)) {
    if (!registry.has(tool.name)) registry.set(tool.name, tool);
  }
}
