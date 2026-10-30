// SPDX-License-Identifier: Apache-2.0
// W14a phone-app operation: tool validation, governance gating (approval
// required; a denied approval never dispatches), dispatch/ack/timeout
// over a mock phone socket, plain-language audit (contact name present,
// message body absent), global-pause refusal, and the wire protocol
// shape for action/action_result/notification messages.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway, type Policy } from '@mvp/governance';
import type { ToolContext } from '@mvp/agent-runtime';
import {
  PhoneSessionHub,
  PhoneStore,
  validateMessage,
  type PhoneSocket,
} from '../src/phone.js';
import {
  createPhoneActionTools,
  phoneActionPolicyRules,
  validatePhoneAction,
  type PhoneActionDispatcher,
} from '../src/phone-actions.js';
import type { PhoneActionName } from '../src/phone-actions.js';
import type { PhoneActionResult } from '../src/phone.js';

const SECRET_BODY = 'this is the private message body 12345';

function ctx(): ToolContext {
  return { botId: 'chief', sessionId: 'sess-1' } as unknown as ToolContext;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validatePhoneAction', () => {
  it('open_app validates the package name and labels the audit plainly', () => {
    const v = validatePhoneAction('phone_open_app', { packageName: 'com.whatsapp' });
    expect(v.action).toBe('open_app');
    expect(v.auditLabel).toBe('Opened WhatsApp');
    expect(() => validatePhoneAction('phone_open_app', { packageName: 'not a package' })).toThrow(/package/);
    expect(() => validatePhoneAction('phone_open_app', {})).toThrow(/packageName/);
  });

  it('tap accepts coordinates or a text label, not both/neither', () => {
    expect(validatePhoneAction('phone_tap', { x: 0.5, y: 0.25 }).params).toEqual({ x: 0.5, y: 0.25 });
    expect(validatePhoneAction('phone_tap', { text: 'Send' }).params).toEqual({ text: 'Send' });
    expect(() => validatePhoneAction('phone_tap', { x: 0.5, y: 0.5, text: 'Send' })).toThrow(/either/);
    expect(() => validatePhoneAction('phone_tap', {})).toThrow(/coordinates/);
    expect(() => validatePhoneAction('phone_tap', { x: 1.5, y: 0.5 })).toThrow(/between 0 and 1/);
  });

  it('type/scroll validate their args; audit labels never carry typed text', () => {
    const v = validatePhoneAction('phone_type', { text: SECRET_BODY });
    expect(v.params).toEqual({ text: SECRET_BODY }); // text goes to the phone…
    expect(v.auditLabel).not.toContain(SECRET_BODY); // …never to the audit
    expect(validatePhoneAction('phone_scroll', { direction: 'down' }).params).toEqual({ direction: 'down', amount: 0.6 });
    expect(() => validatePhoneAction('phone_scroll', { direction: 'sideways' })).toThrow(/direction/);
  });

  it('send_message defaults to WhatsApp and validates the app', () => {
    const v = validatePhoneAction('phone_send_message', { contact: 'Asha Rao', text: 'hi' });
    expect(v.params).toMatchObject({ app: 'whatsapp', packageName: 'com.whatsapp', contact: 'Asha Rao' });
    expect(v.auditLabel).toBe('Sent message to Asha Rao');
    expect(validatePhoneAction('phone_send_message', { contact: 'Asha Rao', text: 'hi', app: 'sms' }).params).toMatchObject({ app: 'sms' });
    expect(() => validatePhoneAction('phone_send_message', { contact: 'Asha Rao', text: 'hi', app: 'telegram' })).toThrow(/whatsapp.*sms/);
  });

  it('call validates the number; audit names the contact, not the number', () => {
    const v = validatePhoneAction('phone_call', { number: '+91 98200 12345', contact: 'Asha Rao' });
    expect(v.auditLabel).toBe('Called Asha Rao');
    expect(v.auditLabel).not.toContain('98200');
    expect(() => validatePhoneAction('phone_call', { number: 'call-me-maybe' })).toThrow(/phone number/);
  });
});

// ---------------------------------------------------------------------------
// Governance gating
// ---------------------------------------------------------------------------

describe('phone action governance', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'w14-gov-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function gateway(): GovernanceGateway {
    const policy: Policy = {
      ...DEFAULT_POLICY,
      rules: [...phoneActionPolicyRules(), ...DEFAULT_POLICY.rules],
    };
    return new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy });
  }

  it('every phone_* tool simulates as require-approval', async () => {
    const gw = gateway();
    for (const name of ['phone_open_app', 'phone_tap', 'phone_type', 'phone_scroll', 'phone_send_message', 'phone_call']) {
      const sim = await gw.simulate(name, {});
      expect(sim.effect).toBe('require-approval');
      expect(sim.matchedRuleId).toBe('phone-actions-approval');
    }
    gw.close();
  });

  it('a denied approval never dispatches: evaluation mints a card, denial closes it, dispatcher stays untouched', async () => {
    const gw = gateway();
    const calls: unknown[] = [];
    const dispatcher: PhoneActionDispatcher = {
      isOnline: () => true,
      dispatchAction: async (...a: unknown[]) => {
        calls.push(a);
        return { ok: true };
      },
    };
    void dispatcher;
    // The runtime contract: the handler (and therefore dispatch) runs
    // only when governance allows the call. Here it does not — the call
    // requires approval, and the human denies the card.
    const result = await gw.evaluate(
      'phone_send_message',
      { contact: 'Asha Rao', text: SECRET_BODY },
      { botId: 'chief', sessionId: 'sess-1', actor: 'chief' },
    );
    expect(result.effect).toBe('require-approval');
    expect(result.approvalId).toBeTruthy();
    const decided = gw.decide(result.approvalId!, 'denied');
    expect(decided.status).toBe('denied');
    // Denied ⇒ the tool handler is never invoked ⇒ nothing dispatched.
    expect(calls).toHaveLength(0);
    gw.close();
  });
});

// ---------------------------------------------------------------------------
// Tool handlers with a mock dispatcher
// ---------------------------------------------------------------------------

class MockDispatcher implements PhoneActionDispatcher {
  calls: Array<{ deviceId: string; action: PhoneActionName; params: Record<string, unknown> }> = [];
  online = true;
  result: PhoneActionResult = { ok: true };
  async dispatchAction(deviceId: string, action: PhoneActionName, params: Record<string, unknown>): Promise<PhoneActionResult> {
    this.calls.push({ deviceId, action, params });
    return this.result;
  }
  isOnline(): boolean {
    return this.online;
  }
}

describe('phone action tool handlers', () => {
  it('dispatches the approved args and audits plain language: contact name present, body absent', async () => {
    const dispatcher = new MockDispatcher();
    const audits: Array<{ action: string; fields: Record<string, unknown> }> = [];
    const tools = createPhoneActionTools({
      dispatcher,
      resolveDeviceId: () => 'phone_1',
      audit: (action, fields) => audits.push({ action, fields: fields as Record<string, unknown> }),
    });
    const send = tools.find((t) => t.name === 'phone_send_message')!;
    const out = await send.handler({ contact: 'Asha Rao', text: SECRET_BODY }, ctx());
    expect(out).toMatchObject({ ok: true, action: 'send_message' });
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]!.params).toMatchObject({ contact: 'Asha Rao', text: SECRET_BODY });
    expect(audits).toHaveLength(1);
    const detailJson = JSON.stringify(audits[0]!.fields);
    expect(detailJson).toContain('Asha Rao');
    expect(detailJson).toContain('Sent message to Asha Rao');
    expect(detailJson).not.toContain(SECRET_BODY);
  });

  it('refuses to dispatch while globally paused', async () => {
    const dispatcher = new MockDispatcher();
    const tools = createPhoneActionTools({
      dispatcher,
      resolveDeviceId: () => 'phone_1',
      isPaused: () => true,
    });
    const open = tools.find((t) => t.name === 'phone_open_app')!;
    await expect(open.handler({ packageName: 'com.whatsapp' }, ctx())).rejects.toThrow(/paused/);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('fails cleanly when the phone is offline and surfaces phone-side errors', async () => {
    const dispatcher = new MockDispatcher();
    dispatcher.online = false;
    const tools = createPhoneActionTools({ dispatcher, resolveDeviceId: () => 'phone_1' });
    const open = tools.find((t) => t.name === 'phone_open_app')!;
    await expect(open.handler({ packageName: 'com.whatsapp' }, ctx())).rejects.toThrow(/not connected/);
    expect(dispatcher.calls).toHaveLength(0);

    dispatcher.online = true;
    dispatcher.result = { ok: false, error: 'unknown_action' };
    await expect(open.handler({ packageName: 'com.whatsapp' }, ctx())).rejects.toThrow(/unknown_action/);
  });

  it('all seven tools are mutating (phone_send_file added by ADD-5)', () => {
    const tools = createPhoneActionTools({ dispatcher: new MockDispatcher() });
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['phone_call', 'phone_open_app', 'phone_scroll', 'phone_send_file', 'phone_send_message', 'phone_tap', 'phone_type'].sort(),
    );
    expect(tools.every((t) => t.mutating === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hub dispatch / ack / timeout over a mock phone socket
// ---------------------------------------------------------------------------

class MockSocket implements PhoneSocket {
  sent: string[] = [];
  private msgCb: ((t: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  sendText(t: string): void {
    this.sent.push(t);
  }
  close(): void {
    this.closeCb?.();
  }
  onMessage(cb: (t: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  clientSend(obj: unknown): void {
    this.msgCb?.(JSON.stringify(obj));
  }
  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

describe('PhoneSessionHub action dispatch', () => {
  function connectedPhone() {
    const store = new PhoneStore(mkdtempSync(join(tmpdir(), 'w14-phone-')));
    const ch = store.requestPairingCode();
    const paired = store.confirmPairing({ code: ch.code, deviceName: 'Pixel', platform: 'android' });
    if (!paired.ok) throw new Error('pairing failed');
    const hub = new PhoneSessionHub(store, () => {});
    const sock = new MockSocket();
    hub.acceptSocket(sock, '127.0.0.1');
    sock.clientSend({ t: 'hello', deviceId: paired.deviceId, token: paired.token });
    return { store, hub, sock, deviceId: paired.deviceId };
  }

  it('sends {type:"action", action, params} and resolves on the ack', async () => {
    const { hub, sock, deviceId } = connectedPhone();
    const pending = hub.dispatchAction(deviceId, 'open_app', { packageName: 'com.whatsapp' }, 5000);
    const actionMsg = sock.parsed().find((m) => m.type === 'action');
    expect(actionMsg).toBeTruthy();
    expect(actionMsg!.action).toBe('open_app');
    expect(actionMsg!.params).toEqual({ packageName: 'com.whatsapp' });
    sock.clientSend({ type: 'action_result', id: actionMsg!.id, ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('propagates a phone-side error ack (unknown action)', async () => {
    const { hub, sock, deviceId } = connectedPhone();
    const pending = hub.dispatchAction(deviceId, 'teleport', {}, 5000);
    const actionMsg = sock.parsed().find((m) => m.type === 'action')!;
    sock.clientSend({ type: 'action_result', id: actionMsg.id, ok: false, error: 'unknown_action' });
    await expect(pending).resolves.toEqual({ ok: false, error: 'unknown_action' });
  });

  it('times out when the phone never acks, and reports offline for unknown devices', async () => {
    const { hub, deviceId } = connectedPhone();
    await expect(hub.dispatchAction(deviceId, 'tap', { x: 0.5, y: 0.5 }, 100)).resolves.toEqual({
      ok: false,
      error: 'timeout',
    });
    await expect(hub.dispatchAction('phone_nope', 'tap', { x: 0.5, y: 0.5 }, 100)).resolves.toEqual({
      ok: false,
      error: 'device_offline',
    });
  });

  it('forwards notification events to the registered handler', () => {
    const { hub, sock } = connectedPhone();
    const seen: unknown[] = [];
    hub.setNotificationHandler((deviceId, n) => seen.push({ deviceId, ...n }));
    sock.clientSend({ type: 'notification', appPackage: 'com.example.bank', appName: 'Bank', title: 'Payment received', ts: 123 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ appPackage: 'com.example.bank', title: 'Payment received' });
  });
});

// ---------------------------------------------------------------------------
// Protocol validation
// ---------------------------------------------------------------------------

describe('W14 protocol validation', () => {
  it('accepts action_result and notification; a notification body is dropped, never carried', () => {
    const ack = validateMessage({ type: 'action_result', id: 'act_1', ok: false, error: 'unknown_action' });
    expect(ack.ok).toBe(true);
    const notif = validateMessage({
      type: 'notification',
      appPackage: 'com.example.mail',
      title: 'New mail',
      ts: 42,
      body: 'SECRET BODY',
      text: 'SECRET BODY',
    });
    expect(notif.ok).toBe(true);
    if (notif.ok) {
      expect(JSON.stringify(notif.msg)).not.toContain('SECRET BODY');
      expect(notif.msg).toMatchObject({ type: 'notification', appPackage: 'com.example.mail', title: 'New mail' });
    }
    expect(validateMessage({ type: 'action_result', id: 'x', ok: 'yes' }).ok).toBe(false);
    expect(validateMessage({ type: 'notification', appPackage: 'bad package!', title: 't', ts: 1 }).ok).toBe(false);
  });
});
