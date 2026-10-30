// SPDX-License-Identifier: Apache-2.0
// phone_send_file (ADD-5 item 3b, server side): validation (plain file
// names only, base64 + 5 MB cap), the approval policy rule covering the
// new tool, dispatch of exactly the approved params to the phone, and an
// audit label that names the file + contact but never carries content.
// The Android half (InputService.kt "send_file": FileProvider share
// intent into the real WhatsApp app + accessibility contact/Send taps)
// is source-level in this environment — no Android SDK on the build VM.

import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mvp/agent-runtime';
import {
  MAX_PHONE_FILE_BYTES,
  createPhoneActionTools,
  phoneActionPolicyRules,
  validatePhoneAction,
  type PhoneActionDispatcher,
} from '../src/phone-actions.js';

const SMALL_B64 = Buffer.from('hello file').toString('base64');
const CTX = { botId: 'bot-1', sessionId: 'sess-1' } as ToolContext;

describe('validatePhoneAction: phone_send_file', () => {
  it('accepts a well-formed file send and targets WhatsApp', () => {
    const v = validatePhoneAction('phone_send_file', {
      contact: 'Asha Rao',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      contentBase64: SMALL_B64,
      caption: 'Q3 report',
    });
    expect(v.action).toBe('send_file');
    expect(v.params).toMatchObject({
      packageName: 'com.whatsapp',
      contact: 'Asha Rao',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      contentBase64: SMALL_B64,
      caption: 'Q3 report',
    });
    expect(v.auditLabel).toBe('Sent file report.pdf to Asha Rao');
    expect(v.contactName).toBe('Asha Rao');
  });

  it('defaults the mime type and rejects path-y file names', () => {
    const v = validatePhoneAction('phone_send_file', { contact: 'A', fileName: 'a.bin', contentBase64: SMALL_B64 });
    expect(v.params.mimeType).toBe('application/octet-stream');
    for (const bad of ['../secret.pdf', 'a/b.pdf', 'a\\b.pdf', '..']) {
      expect(() =>
        validatePhoneAction('phone_send_file', { contact: 'A', fileName: bad, contentBase64: SMALL_B64 }),
      ).toThrow(/plain file name/);
    }
  });

  it('rejects missing, non-base64, empty and oversized content', () => {
    expect(() => validatePhoneAction('phone_send_file', { contact: 'A', fileName: 'a.pdf' })).toThrow(/contentBase64/);
    expect(() =>
      validatePhoneAction('phone_send_file', { contact: 'A', fileName: 'a.pdf', contentBase64: 'not!!base64' }),
    ).toThrow(/valid base64/);
    const oversized = Buffer.alloc(MAX_PHONE_FILE_BYTES + 1, 7).toString('base64');
    expect(() =>
      validatePhoneAction('phone_send_file', { contact: 'A', fileName: 'a.pdf', contentBase64: oversized }),
    ).toThrow(/base64 of at most|between 1 byte/);
  });

  it('rejects a bad mime type', () => {
    expect(() =>
      validatePhoneAction('phone_send_file', { contact: 'A', fileName: 'a.pdf', contentBase64: SMALL_B64, mimeType: 'pdf' }),
    ).toThrow(/mimeType/);
  });
});

describe('phone_send_file governance + dispatch', () => {
  it('the policy rules force require-approval for phone_send_file (governance never weakened)', () => {
    const rules = phoneActionPolicyRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.effect).toBe('require-approval');
    expect(new RegExp(rules[0]!.toolPattern).test('phone_send_file')).toBe(true);
  });

  function fakeDispatcher(result: { ok: boolean; error?: string } = { ok: true }) {
    const dispatched: Array<{ deviceId: string; action: string; params: Record<string, unknown> }> = [];
    const dispatcher: PhoneActionDispatcher = {
      dispatchAction: async (deviceId, action, params) => {
        dispatched.push({ deviceId, action, params });
        return result;
      },
      isOnline: () => true,
    };
    return { dispatcher, dispatched };
  }

  it('dispatches exactly the approved params and audits name+contact only', async () => {
    const { dispatcher, dispatched } = fakeDispatcher();
    const audit = vi.fn();
    const tools = createPhoneActionTools({ dispatcher, resolveDeviceId: () => 'dev-1', audit });
    const tool = tools.find((t) => t.name === 'phone_send_file')!;
    expect(tool).toBeDefined();
    expect(tool.mutating).toBe(true);
    const out = await tool.handler(
      { contact: 'Asha Rao', fileName: 'report.pdf', mimeType: 'application/pdf', contentBase64: SMALL_B64 },
      CTX,
    );
    expect(out).toMatchObject({ ok: true, action: 'send_file', deviceId: 'dev-1' });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.action).toBe('send_file');
    expect(dispatched[0]!.params.contentBase64).toBe(SMALL_B64);
    const auditDetail = JSON.stringify(audit.mock.calls[0]![1]);
    expect(auditDetail).toMatch(/Sent file report\.pdf to Asha Rao/);
    expect(auditDetail).not.toContain(SMALL_B64);
  });

  it('surfaces a phone-side failure (e.g. send button not found) as a tool error', async () => {
    const { dispatcher } = fakeDispatcher({ ok: false, error: 'send_button_not_found' });
    const tools = createPhoneActionTools({ dispatcher, resolveDeviceId: () => 'dev-1' });
    const tool = tools.find((t) => t.name === 'phone_send_file')!;
    await expect(
      tool.handler({ contact: 'A', fileName: 'a.pdf', contentBase64: SMALL_B64 }, CTX),
    ).rejects.toThrow(/send_button_not_found/);
  });
});
