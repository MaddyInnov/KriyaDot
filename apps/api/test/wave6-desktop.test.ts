// SPDX-License-Identifier: Apache-2.0
// Wave-6 DV-7 (camera), DV-9 (OS data binding), DV-10 (WhatsApp local store).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CameraCaptureService, cameraCapturePolicyRules, planCameraCommand,
} from '../src/camera-capture.js';
import {
  BindingConfigStore, BoundPersonalDataService, createKriyaDotProvider, createPhoneOsProvider,
  osBindingPolicyRules,
} from '../src/os-data-binding.js';
import {
  WhatsappLocalStoreSearch, detectWhatsappStore, extractStrings, whatsappLocalPolicyRules,
  whatsappStoreCandidates, type StoreFs,
} from '../src/whatsapp-local-store.js';
import type { PhoneActionResult } from '../src/phone.js';

const ctx = { botId: 'b1', sessionId: 's1' } as never;

// ---------------------------------------------------------------- DV-7

describe('DV-7 camera command planning', () => {
  it('prefers fswebcam on Linux, falls back to ffmpeg v4l2', () => {
    expect(planCameraCommand('linux', () => true, '/tmp/x.jpg')?.tool).toBe('fswebcam');
    expect(planCameraCommand('linux', (c) => c === 'ffmpeg', '/tmp/x.jpg')).toMatchObject({
      tool: 'ffmpeg-v4l2', args: expect.arrayContaining(['/dev/video0']),
    });
    expect(planCameraCommand('linux', (c) => c === 'ffmpeg', '/tmp/x.jpg', { device: '/dev/video2' })?.args).toContain('/dev/video2');
  });
  it('macOS uses imagesnap; Windows uses ffmpeg dshow; unknown platform → null', () => {
    expect(planCameraCommand('darwin', () => true, '/tmp/x.jpg')?.tool).toBe('imagesnap');
    expect(planCameraCommand('win32', () => true, '/tmp/x.jpg')?.args.join(' ')).toContain('video=Integrated Camera');
    expect(planCameraCommand('freebsd', () => true, '/tmp/x.jpg')).toBeNull();
    expect(planCameraCommand('linux', () => false, '/tmp/x.jpg')).toBeNull();
  });
});

describe('DV-7 CameraCaptureService (mock runner)', () => {
  it('captures via the injected runner and reports path + bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cam-'));
    const seen: string[] = [];
    const svc = new CameraCaptureService({
      dataDir: dir,
      platform: 'linux',
      isAvailable: () => true,
      runner: async (cmd, args) => {
        seen.push(cmd, ...args);
        writeFileSync(args[args.length - 1] as string, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      },
      now: () => 1234,
    });
    const out = await svc.capture();
    expect(seen[0]).toBe('fswebcam');
    expect(out).toMatchObject({ ok: true, bytes: 4, tool: 'fswebcam', capturedAt: 1234 });
    expect(out.path).toContain('camera-captures');
  });
  it('honest unavailable error when no camera tool exists', async () => {
    const svc = new CameraCaptureService({
      dataDir: mkdtempSync(join(tmpdir(), 'cam-')),
      platform: 'linux',
      isAvailable: () => false,
      runner: async () => {},
    });
    await expect(svc.capture()).rejects.toThrow(/no camera capture tool available/);
  });
  it('policy requires approval', () => {
    expect(cameraCapturePolicyRules()[0]!.effect).toBe('require-approval');
  });
});

// ---------------------------------------------------------------- DV-9

function phoneDispatcher(result: PhoneActionResult, online = true) {
  return {
    dispatchDataQuery: async () => result,
    isOnline: () => online,
  };
}

describe('DV-9 binding layer', () => {
  it('defaults to the OS source and maps phone rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bind-'));
    const config = new BindingConfigStore(dir);
    expect(config.all()).toEqual({ contacts: 'os', calendar: 'os' });
    const os = createPhoneOsProvider({
      dispatcher: phoneDispatcher({ ok: true, data: { contacts: [{ name: 'Asha', phone: '+911' }] } }),
      resolveDeviceId: () => 'phone_1',
    });
    const local = createKriyaDotProvider({ listLocalEvents: () => [] });
    const svc = new BoundPersonalDataService({ os, kriyadot: local }, config);
    const out = await svc.searchContacts('Asha', 10);
    expect(out).toMatchObject({ source: 'os', fellBack: false });
    expect(out.results).toEqual([{ name: 'Asha', phone: '+911', email: undefined }]);
  });
  it('falls back to KriyaDot events when the phone is offline — and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bind-'));
    const config = new BindingConfigStore(dir);
    const now = Date.parse('2026-10-30T00:00:00Z');
    const os = createPhoneOsProvider({ dispatcher: phoneDispatcher({ ok: false, error: 'device_offline' }, false), resolveDeviceId: () => 'phone_1' });
    const local = createKriyaDotProvider({
      listLocalEvents: () => [
        { title: 'Dentist', startsAt: '2026-10-31T10:00:00Z', endsAt: '2026-10-31T11:00:00Z' },
        { title: 'Old', startsAt: '2026-10-01T10:00:00Z' },
      ],
      now: () => now,
    });
    const svc = new BoundPersonalDataService({ os, kriyadot: local }, config);
    const out = await svc.listCalendar(7, 50);
    expect(out.source).toBe('kriyadot');
    expect(out.fellBack).toBe(true);
    expect(out.selectedError).toMatch(/unavailable/);
    expect(out.results.map((e) => e.title)).toEqual(['Dentist']);
  });
  it('explicit selection persists and is honored (kriyadot contacts without a local store fall back to OS)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bind-'));
    const config = new BindingConfigStore(dir);
    config.set('contacts', 'kriyadot');
    expect(new BindingConfigStore(dir).get('contacts')).toBe('kriyadot'); // persisted
    expect(() => config.set('contacts', 'carrier-pigeon' as never)).toThrow(/source/);
    const os = createPhoneOsProvider({
      dispatcher: phoneDispatcher({ ok: true, data: { contacts: [{ name: 'Ravi' }] } }),
      resolveDeviceId: () => 'phone_1',
    });
    const local = createKriyaDotProvider({ listLocalEvents: () => [] });
    const svc = new BoundPersonalDataService({ os, kriyadot: local }, config);
    const out = await svc.searchContacts(undefined, 10);
    expect(out).toMatchObject({ source: 'os', fellBack: true });
    expect(osBindingPolicyRules()[0]!.effect).toBe('require-approval');
  });
  it('throws a combined error when both sources fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bind-'));
    const os = createPhoneOsProvider({ dispatcher: phoneDispatcher({ ok: false, error: 'device_offline' }, false), resolveDeviceId: () => undefined });
    const local = createKriyaDotProvider({ listLocalEvents: () => { throw new Error('disk gone'); } });
    const svc = new BoundPersonalDataService({ os, kriyadot: local }, new BindingConfigStore(dir));
    await expect(svc.listCalendar(7, 10)).rejects.toThrow(/both contact\/calendar sources failed/);
  });
});

// ---------------------------------------------------------------- DV-10

function mockFs(files: Record<string, Buffer>): StoreFs {
  const paths = Object.keys(files);
  return {
    exists: (p) => paths.some((f) => f === p || f.startsWith(p + '/')),
    walk: (dir) => paths.filter((f) => f.startsWith(dir)),
    read: (p) => files[p] as Buffer,
    size: (p) => (files[p] as Buffer).length,
  };
}

describe('DV-10 WhatsApp local store search', () => {
  it('extractStrings recovers printable runs around binary bytes', () => {
    const buf = Buffer.concat([
      Buffer.from([0x00, 0x01, 0xfe]),
      Buffer.from('hello world, the meeting moved to Friday', 'utf8'),
      Buffer.from([0x00, 0x02]),
      Buffer.from('short', 'utf8'),
    ]);
    const strings = extractStrings(buf);
    expect(strings.some((s) => s.text.includes('meeting moved to Friday'))).toBe(true);
  });
  it('candidates are platform-shaped', () => {
    expect(whatsappStoreCandidates('linux', '/home/u').some((p) => p.includes('.config'))).toBe(true);
    expect(whatsappStoreCandidates('win32', 'C:\\Users\\u', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })[0]).toContain('Packages');
    expect(whatsappStoreCandidates('plan9', '/home/u')).toEqual([]);
  });
  it('search finds message text in a mock LevelDB log and names the file', () => {
    const root = join('/home/u', '.config', 'WhatsApp');
    const logFile = join(root, 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb', '000003.log');
    const files: Record<string, Buffer> = {
      [logFile]: Buffer.concat([
        Buffer.from([0x10, 0x00, 0x99]),
        Buffer.from('{"body":"Invoice for October is ready, total 4200"}', 'utf8'),
        Buffer.from([0x00, 0x00]),
        Buffer.from('unrelated chatter here', 'utf8'),
      ]),
    };
    const search = new WhatsappLocalStoreSearch({ fs: mockFs(files), platform: 'linux', home: '/home/u' });
    expect(search.detect().available).toBe(true);
    const out = search.search('invoice for october');
    expect(out.available).toBe(true);
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]!.file).toBe(logFile);
    expect(out.hits[0]!.snippet).toContain('Invoice for October');
    expect(out.coverageNote).toContain('not found in the readable portion');
    expect(search.search('nonexistent phrase').hits).toEqual([]);
  });
  it('honest unavailable state when no store exists', () => {
    const fs: StoreFs = { exists: () => false, walk: () => [], read: () => Buffer.alloc(0), size: () => 0 };
    expect(detectWhatsappStore(fs, 'linux', '/home/u').available).toBe(false);
    const search = new WhatsappLocalStoreSearch({ fs, platform: 'linux', home: '/home/u' });
    const out = search.search('anything');
    expect(out).toMatchObject({ available: false, hits: [], filesScanned: 0 });
    expect(whatsappLocalPolicyRules()[0]!.effect).toBe('require-approval');
    expect(ctx).toBeDefined();
  });
});
