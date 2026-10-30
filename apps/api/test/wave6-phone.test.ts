// SPDX-License-Identifier: Apache-2.0
// Wave-6 DV-3 (packaged phone commands) + DV-6 (background control) tests.
import { describe, expect, it } from 'vitest';
import {
  createPhonePackagedTools, phonePackagedPolicyRules, validateCallHistory, validateSetAlarm,
} from '../src/phone-packaged.js';
import {
  assessBackgroundSupport, createPhoneBackgroundTools, phoneBackgroundPolicyRules,
  BACKGROUND_ACTION_MATRIX,
} from '../src/phone-background.js';
import type { PhoneActionResult } from '../src/phone.js';

const ctx = { botId: 'b1', sessionId: 's1' } as never;

function fakeActionDispatcher(result: PhoneActionResult = { ok: true }) {
  const calls: Array<{ deviceId: string; action: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    dispatcher: {
      dispatchAction: async (deviceId: string, action: string, params: Record<string, unknown>) => {
        calls.push({ deviceId, action, params });
        return result;
      },
      isOnline: () => true,
    },
  };
}

function fakeDataDispatcher(result: PhoneActionResult) {
  const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    dispatcher: {
      dispatchDataQuery: async (_d: string, query: string, params: Record<string, unknown>) => {
        calls.push({ query, params });
        return result;
      },
      isOnline: () => true,
    },
  };
}

describe('DV-3 validateSetAlarm', () => {
  it('normalizes a one-shot alarm with skipUi and a padded audit label', () => {
    const v = validateSetAlarm({ hour: 7, minute: 5 });
    expect(v.action).toBe('set_alarm');
    expect(v.params).toEqual({ hour: 7, minute: 5, skipUi: true });
    expect(v.auditLabel).toContain('07:05');
  });
  it('dedupes + sorts repeat days and keeps label/vibrate', () => {
    const v = validateSetAlarm({ hour: 6, minute: 30, days: [6, 2, 2, 4], label: ' Gym ', vibrate: false });
    expect(v.params['days']).toEqual([2, 4, 6]);
    expect(v.params['label']).toBe('Gym');
    expect(v.params['vibrate']).toBe(false);
  });
  it('rejects bad hour/minute/days', () => {
    expect(() => validateSetAlarm({ hour: 24, minute: 0 })).toThrow(/hour/);
    expect(() => validateSetAlarm({ hour: 7, minute: 60 })).toThrow(/minute/);
    expect(() => validateSetAlarm({ hour: 7, minute: 0, days: [0] })).toThrow(/days/);
    expect(() => validateSetAlarm({ hour: 7, minute: 0, days: [] })).toThrow(/days/);
  });
});

describe('DV-3 validateCallHistory', () => {
  it('defaults + clamps and drops type=all', () => {
    expect(validateCallHistory({})).toMatchObject({ query: 'call_history', params: { limit: 30, daysBack: 30 } });
    expect(validateCallHistory({ limit: 9999, daysBack: 0 }).params).toEqual({ limit: 200, daysBack: 1 });
    expect(validateCallHistory({ type: 'missed', query: ' Asha ' }).params).toMatchObject({ type: 'missed', query: 'Asha' });
  });
  it('rejects an unknown type', () => {
    expect(() => validateCallHistory({ type: 'carrier-pigeon' })).toThrow(/type/);
  });
});

describe('DV-3 packaged tools end-to-end (mock dispatchers)', () => {
  it('phone_set_alarm dispatches set_alarm with validated params and audits', async () => {
    const { calls, dispatcher } = fakeActionDispatcher();
    const data = fakeDataDispatcher({ ok: true, data: {} });
    const audits: unknown[] = [];
    const tools = createPhonePackagedTools({
      actionDispatcher: dispatcher,
      dataDispatcher: data.dispatcher,
      resolveDeviceId: () => 'phone_1',
      audit: (_a, f) => audits.push(f.detail),
    });
    const alarm = tools.find((t) => t.name === 'phone_set_alarm')!;
    await expect(alarm.handler({ hour: 8, minute: 15 }, ctx)).resolves.toMatchObject({ ok: true, command: 'set_alarm' });
    expect(calls).toEqual([{ deviceId: 'phone_1', action: 'set_alarm', params: { hour: 8, minute: 15, skipUi: true } }]);
    expect(audits).toHaveLength(1);
  });
  it('phone_call_history returns rows; audit holds no row data', async () => {
    const action = fakeActionDispatcher();
    const rows = { calls: [{ number: '+9112345', type: 'missed', date: 1 }] };
    const data = fakeDataDispatcher({ ok: true, data: rows });
    const audits: unknown[] = [];
    const tools = createPhonePackagedTools({
      actionDispatcher: action.dispatcher,
      dataDispatcher: data.dispatcher,
      resolveDeviceId: () => 'phone_1',
      audit: (_a, f) => audits.push(f.detail),
    });
    const hist = tools.find((t) => t.name === 'phone_call_history')!;
    await expect(hist.handler({ type: 'missed' }, ctx)).resolves.toMatchObject({ ok: true, data: rows });
    expect(data.calls[0]).toMatchObject({ query: 'call_history', params: { type: 'missed' } });
    expect(JSON.stringify(audits)).not.toContain('+9112345');
  });
  it('surfaces a timeout as an older-build hint and honors the pause gate', async () => {
    const action = fakeActionDispatcher({ ok: false, error: 'timeout' });
    const data = fakeDataDispatcher({ ok: true });
    const tools = createPhonePackagedTools({
      actionDispatcher: action.dispatcher, dataDispatcher: data.dispatcher, resolveDeviceId: () => 'phone_1',
    });
    await expect(tools[0]!.handler({ hour: 1, minute: 1 }, ctx)).rejects.toThrow(/older build/);
    const paused = createPhonePackagedTools({
      actionDispatcher: action.dispatcher, dataDispatcher: data.dispatcher, resolveDeviceId: () => 'phone_1', isPaused: () => true,
    });
    await expect(paused[0]!.handler({ hour: 1, minute: 1 }, ctx)).rejects.toThrow(/paused/);
  });
  it('policy rules require approval for both tools', () => {
    const rules = phonePackagedPolicyRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.effect).toBe('require-approval');
    const re = new RegExp(rules[0]!.toolPattern);
    expect(re.test('phone_set_alarm')).toBe(true);
    expect(re.test('phone_call_history')).toBe(true);
    expect(re.test('phone_tap')).toBe(false);
  });
});

describe('DV-6 background assessment', () => {
  it('supported when accessibility is on and headless permissions are granted', () => {
    const a = assessBackgroundSupport(
      { accessibilityEnabled: true, permissions: { READ_SMS: true, SEND_SMS: true, CALL_PHONE: true, READ_CALL_LOG: true, READ_CALENDAR: false } },
      true,
    );
    expect(a.nonFrontedDispatch).toBe('supported');
    expect(a.uiAutomation).toBe('supported');
    expect(a.headlessActions).toBe('supported');
    expect(a.serviceResident).toBe('online');
    expect(a.missingPermissions).toEqual(['READ_CALENDAR']);
    expect(a.limits.length).toBeGreaterThanOrEqual(4);
  });
  it('degrades honestly without accessibility / when offline', () => {
    const a = assessBackgroundSupport({ accessibilityEnabled: false, permissions: { SEND_SMS: false } }, true);
    expect(a.uiAutomation).toBe('degraded');
    expect(a.headlessActions).toBe('degraded');
    const off = assessBackgroundSupport(null, false);
    expect(off.uiAutomation).toBe('unknown');
    expect(off.serviceResident).toBe('offline');
  });
  it('matrix marks open_app as fronting the target but never the agent', () => {
    const open = BACKGROUND_ACTION_MATRIX.find((m) => m.action === 'open_app')!;
    expect(open.runsWithoutAgentFronted).toBe(true);
    expect(open.frontsTargetApp).toBe(true);
    for (const row of BACKGROUND_ACTION_MATRIX) expect(row.runsWithoutAgentFronted).toBe(true);
  });
  it('phone_background_report tool probes capabilities and returns the assessment', async () => {
    const data = fakeDataDispatcher({
      ok: true,
      data: { sdkInt: 34, accessibilityEnabled: true, permissions: { READ_SMS: true, SEND_SMS: true, CALL_PHONE: true, READ_CALL_LOG: true } },
    });
    const tools = createPhoneBackgroundTools({ dataDispatcher: data.dispatcher, resolveDeviceId: () => 'phone_1' });
    const out = (await tools[0]!.handler({}, ctx)) as { assessment: { uiAutomation: string }; capabilities: { sdkInt: number } };
    expect(data.calls[0]!.query).toBe('capabilities');
    expect(out.assessment.uiAutomation).toBe('supported');
    expect(out.capabilities.sdkInt).toBe(34);
    expect(phoneBackgroundPolicyRules()[0]!.effect).toBe('require-approval');
  });
  it('report with no phone still returns the design verdict, residency offline', async () => {
    const data = fakeDataDispatcher({ ok: false, error: 'device_offline' });
    const tools = createPhoneBackgroundTools({ dataDispatcher: data.dispatcher, resolveDeviceId: () => undefined });
    const out = (await tools[0]!.handler({}, ctx)) as { deviceId: null; assessment: { serviceResident: string } };
    expect(out.deviceId).toBeNull();
    expect(out.assessment.serviceResident).toBe('offline');
  });
});
