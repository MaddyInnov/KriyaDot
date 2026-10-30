// SPDX-License-Identifier: Apache-2.0
// Wave-6 DV-12 (LAN discovery), DV-13 (home proxy), DV-15 (Shelly),
// DV-14 (Lutron HAP), DV-16 (IPP). All transports are mocks — zero network.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LanDiscoveryService, buildDnsQuery, buildMSearch, decodeDnsName, encodeDnsName,
  foldMdnsRecords, identifyVendor, parseDnsMessage, parseSsdpResponse, DNS_TYPE,
} from '../src/lan-discovery.js';
import {
  HomeControlProxy, HostGrantStore, normalizeHostKey, proxyTransport,
  createHomeProxyTools, type HttpTransport,
} from '../src/home-control-proxy.js';
import { ShellyClient, createShellyTools, shellyPolicyRules } from '../src/shelly.js';
import {
  HapClient, HapPairingError, LutronHapBridge, createLutronHapTools, lutronHapPolicyRules,
  mapLutronDevices, type HapAccessory, type HapTransport,
} from '../src/lutron-hap.js';
import {
  IppClient, buildIppRequest, encodeIppGroup, ippPolicyRules, ippStatusText,
  operationAttributes, parseIppResponse, IPP_OP, IPP_TAG, IPP_VALUE_TAG,
  type IppAttribute,
} from '../src/ipp-print.js';

const ctx = { botId: 'b1', sessionId: 's1' } as never;

// ---------------------------------------------------------------- DV-12

describe('DV-12 DNS codec', () => {
  it('encodes names and queries; decodes with compression pointers', () => {
    expect([...encodeDnsName('_http._tcp.local')]).toEqual([5, ...Buffer.from('_http'), 4, ...Buffer.from('_tcp'), 5, ...Buffer.from('local'), 0]);
    const q = buildDnsQuery('_http._tcp.local', DNS_TYPE.PTR);
    expect(q.readUInt16BE(4)).toBe(1); // QDCOUNT
    // Hand-built response: header + question + one PTR answer w/ compression.
    const question = Buffer.concat([encodeDnsName('_http._tcp.local'), Buffer.from([0, 12, 0, 1])]);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x8400, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(1, 6);
    const target = encodeDnsName('My Printer._http._tcp.local');
    const answer = Buffer.concat([
      Buffer.from([0xc0, 0x0c]), // pointer to the question name
      Buffer.from([0, 12, 0, 1]), // PTR, IN
      Buffer.from([0, 0, 0, 120]), // TTL
      Buffer.from([0, target.length]),
      target,
    ]);
    const msg = Buffer.concat([header, question, answer]);
    expect(decodeDnsName(msg, 12).name).toBe('_http._tcp.local');
    const records = parseDnsMessage(msg);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: DNS_TYPE.PTR, target: 'My Printer._http._tcp.local' });
  });
  it('folds PTR/SRV/TXT/A records into service instances', () => {
    const svc = '_http._tcp.local';
    const inst = 'Plug._http._tcp.local';
    const folded = foldMdnsRecords(svc, [
      { name: svc, type: DNS_TYPE.PTR, ttl: 120, target: inst },
      { name: inst, type: DNS_TYPE.SRV, ttl: 120, target: 'plug.local', port: 80 },
      { name: inst, type: DNS_TYPE.TXT, ttl: 120, txt: { md: 'ShellyPlugS' } },
      { name: 'plug.local', type: DNS_TYPE.A, ttl: 120, address: '192.168.1.41' },
    ]);
    expect(folded).toEqual([{ instance: inst, host: '192.168.1.41', port: 80, txt: { md: 'ShellyPlugS' } }]);
  });
});

describe('DV-12 SSDP', () => {
  it('builds M-SEARCH and parses responses; identifies vendors', () => {
    expect(buildMSearch('ssdp:all')).toContain('ST: ssdp:all');
    const parsed = parseSsdpResponse(
      'HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nSERVER: Linux/5.4 UPnP/1.0 Sonos/1.0\r\nUSN: uuid:abc::urn:x\r\nLOCATION: http://192.168.1.9/desc.xml\r\n\r\n',
      '192.168.1.9',
    );
    expect(parsed).toMatchObject({ host: '192.168.1.9', server: expect.stringContaining('Sonos') });
    expect(parseSsdpResponse('NOTIFY * HTTP/1.1\r\n\r\n', 'x')).toBeNull();
    expect(identifyVendor('Sonos/1.0')).toBe('Sonos');
    expect(identifyVendor('Shelly/1.0')).toContain('Shelly');
    expect(identifyVendor('MysteryBox')).toBeUndefined();
  });
  it('service merges mock transports, dedupes and sorts', async () => {
    const svc = new LanDiscoveryService({
      ssdp: {
        search: async () => [
          { host: '192.168.1.9', st: 'ssdp:all', server: 'Sonos', usn: 'uuid:1', headers: {} },
          { host: '192.168.1.9', st: 'ssdp:all', server: 'Sonos', usn: 'uuid:1', headers: {} },
        ],
      },
      mdns: {
        browse: async () => [{ instance: 'Plug._shelly._tcp.local', host: '192.168.1.41', port: 80, txt: { md: 'ShellyPlugS' } }],
      },
    });
    const out = await svc.discover({ ssdpTargets: ['ssdp:all'], mdnsServices: ['_shelly._tcp'], timeoutMs: 500 });
    expect(out.errors).toEqual([]);
    expect(out.devices).toHaveLength(2);
    expect(out.devices.find((d) => d.host === '192.168.1.41')).toMatchObject({ via: 'mdns', vendor: expect.stringContaining('Shelly'), model: 'ShellyPlugS' });
  });
});

// ---------------------------------------------------------------- DV-13

describe('DV-13 host keys + grant store', () => {
  it('normalizes hosts and rejects credentialed/junk input', () => {
    expect(normalizeHostKey('192.168.1.20')).toBe('192.168.1.20:80');
    expect(normalizeHostKey('Plug.LOCAL:8080')).toBe('plug.local:8080');
    expect(normalizeHostKey('https://plug.local/admin')).toBe('plug.local:443');
    expect(() => normalizeHostKey('http://user:pass@plug.local/')).toThrow(/credentials/);
    expect(() => normalizeHostKey('not a host!!')).toThrow(/valid hostname/);
    expect(() => normalizeHostKey('plug.local:99999')).toThrow(/port/);
  });
  it('grants persist, expire and revoke', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grants-'));
    const store = new HostGrantStore(dir);
    store.approve('plug.local:80', { label: 'Desk plug', ttlMs: 1000, now: 1000 });
    expect(store.getGrant('plug.local:80', 1500)?.label).toBe('Desk plug');
    expect(store.getGrant('plug.local:80', 2500)).toBeUndefined(); // expired
    expect(new HostGrantStore(dir).listGrants()).toHaveLength(1); // persisted
    expect(store.revoke('plug.local:80')).toBe(true);
    expect(store.getGrant('plug.local:80', 1200)).toBeUndefined();
  });
});

describe('DV-13 proxy approval gate', () => {
  it('first contact never touches the network; after approval calls ride the grant; everything audited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grants-'));
    const store = new HostGrantStore(dir);
    const sent: Array<{ method: string; url: string }> = [];
    const transport: HttpTransport = async (req) => {
      sent.push({ method: req.method, url: req.url });
      return { status: 200, bodyText: '{"ok":true}' };
    };
    const audits: Array<{ action: string; detail: unknown }> = [];
    const proxy = new HomeControlProxy(store, transport, (action, f) => audits.push({ action, detail: f.detail }));

    const first = await proxy.call({ host: 'plug.local', path: '/relay/0?turn=on' });
    expect(first.status).toBe('approval_required');
    expect(sent).toHaveLength(0); // network untouched
    expect(store.listPending()).toHaveLength(1);
    expect(store.listPending()[0]).toMatchObject({ hostKey: 'plug.local:80', attempts: 1 });

    proxy.approve('plug.local', { approvedBy: 'user' });
    expect(store.listPending()).toHaveLength(0);
    const second = await proxy.call({ host: 'plug.local', path: '/relay/0?turn=on' });
    expect(second).toMatchObject({ status: 'ok', httpStatus: 200 });
    expect(sent).toEqual([{ method: 'GET', url: 'http://plug.local/relay/0?turn=on' }]);
    expect(audits.map((a) => a.action)).toEqual(['home_proxy.approval_required', 'home_proxy.approved', 'home_proxy.call']);

    proxy.revoke('plug.local');
    const third = await proxy.call({ host: 'plug.local', path: '/status' });
    expect(third.status).toBe('approval_required');
    expect(sent).toHaveLength(1);
  });
  it('proxyTransport surfaces approval_required as an error for device clients', async () => {
    const store = new HostGrantStore(mkdtempSync(join(tmpdir(), 'grants-')));
    const proxy = new HomeControlProxy(store, async () => ({ status: 200, bodyText: '{}' }));
    const t = proxyTransport(proxy);
    await expect(t({ method: 'GET', url: 'http://plug.local:80/status' })).rejects.toThrow(/approval_required/);
  });
  it('home_device_call tool returns approval_required instead of executing', async () => {
    const store = new HostGrantStore(mkdtempSync(join(tmpdir(), 'grants-')));
    let hits = 0;
    const proxy = new HomeControlProxy(store, async () => { hits += 1; return { status: 200, bodyText: '' }; });
    const tools = createHomeProxyTools({ proxy });
    const out = (await tools[0]!.handler({ host: '192.168.1.5', path: '/status' }, ctx)) as { status: string };
    expect(out.status).toBe('approval_required');
    expect(hits).toBe(0);
  });
});

// ---------------------------------------------------------------- DV-15

function shellyMock(gen: 1 | 2) {
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  const state = { on: false, apower: 42.5 };
  const transport: HttpTransport = async (req) => {
    requests.push({ method: req.method, url: req.url, body: req.body });
    const url = new URL(req.url);
    const json = (v: unknown) => ({ status: 200, bodyText: JSON.stringify(v) });
    if (url.pathname === '/shelly') return json(gen === 2 ? { gen: 2, type: 'SNSW-001P16EU', mac: 'AA', model: 'ShellyPlus1PM' } : { type: 'SHSW-PM', mac: 'BB' });
    if (gen === 2 && url.pathname === '/rpc') {
      const body = JSON.parse(req.body ?? '{}') as { method: string; params?: { on?: boolean } };
      if (body.method === 'Switch.Set') { state.on = body.params?.on === true; return json({ result: state.on }); }
      if (body.method === 'Switch.GetStatus') return json({ result: { output: state.on, apower: state.on ? state.apower : 0, voltage: 230.1, current: 0.2, aenergy: { total: 1234 }, temperature: { tC: 41 } } });
      if (body.method === 'Switch.GetConfig') return json({ result: { id: 0, name: 'Desk' } });
      if (body.method === 'Sys.GetConfig') return json({ result: { device: { name: 'Plug' } } });
      if (body.method === 'Schedule.List') return json({ result: { jobs: [{ id: 1, enable: true, timespec: '0 30 7 * * MON-FRI', calls: [] }] } });
      if (body.method === 'Schedule.Create') return json({ result: { id: 7 } });
      if (body.method === 'Schedule.Delete') return json({ result: null });
      return json({ error: { message: 'unknown' } });
    }
    if (gen === 1 && url.pathname.startsWith('/relay/')) {
      state.on = url.search.includes('turn=on');
      return json({ ison: state.on });
    }
    if (gen === 1 && url.pathname === '/status') return json({ relays: [{ ison: state.on }], meters: [{ power: state.on ? 99 : 0, total: 600 }], temperature: 38 });
    if (gen === 1 && url.pathname === '/settings') return json({ name: 'Gen1Plug' });
    if (gen === 1 && url.pathname.startsWith('/settings/relay/')) return json({});
    return { status: 404, bodyText: 'not found' };
  };
  return { transport, requests, state };
}

describe('DV-15 Shelly client (mock transports)', () => {
  it('Gen2: auto-detects, switches with metering, lists schedules', async () => {
    const mock = shellyMock(2);
    const client = new ShellyClient({ host: '192.168.1.41', transport: mock.transport });
    expect((await client.info()).generation).toBe(2);
    const status = await client.setRelay(0, true);
    expect(status).toMatchObject({ on: true, powerW: 42.5, voltageV: 230.1, energyWh: 1234 });
    expect(mock.requests.some((r) => r.url.endsWith('/rpc') && (r.body ?? '').includes('Switch.Set'))).toBe(true);
    const schedules = await client.listSchedules();
    expect(schedules).toMatchObject({ editable: true, schedules: [{ id: 1, enabled: true }] });
    await expect(client.createSchedule(0, '0 30 7 * * MON-FRI', true)).resolves.toEqual({ id: 7 });
    const cfg = await client.getConfig(0);
    expect(cfg).toMatchObject({ switch: { name: 'Desk' } });
  });
  it('Gen1: relay REST + status metering (watt-minutes converted to Wh)', async () => {
    const mock = shellyMock(1);
    const client = new ShellyClient({ host: 'plug.local', transport: mock.transport });
    expect((await client.info()).generation).toBe(1);
    const status = await client.setRelay(0, true);
    expect(status).toMatchObject({ on: true, powerW: 99, energyWh: 10 }); // Gen1 total 600 watt-minutes = 10 Wh
  });
  it('Shelly errors surface HTTP status; tool is approval-gated', async () => {
    const client = new ShellyClient({
      host: 'x', generation: 2,
      transport: async () => ({ status: 500, bodyText: 'boom' }),
    });
    await expect(client.relayStatus(0)).rejects.toThrow(/HTTP 500/);
    expect(shellyPolicyRules()[0]!.effect).toBe('require-approval');
    const mock = shellyMock(2);
    const tools = createShellyTools({ createClient: (host) => new ShellyClient({ host, transport: mock.transport }) });
    const out = (await tools[0]!.handler({ host: '192.168.1.41', action: 'status' }, ctx)) as { ok: boolean };
    expect(out.ok).toBe(true);
  });
});

// ---------------------------------------------------------------- DV-14

const HAP_DB: { accessories: HapAccessory[] } = {
  accessories: [
    {
      aid: 2,
      services: [
        { iid: 1, type: '3E', characteristics: [{ aid: 2, iid: 2, type: '23', value: 'Living Room Lamp' }] },
        {
          iid: 10, type: '43', characteristics: [
            { aid: 2, iid: 11, type: '25', value: false },
            { aid: 2, iid: 12, type: '08', value: 50 },
            { aid: 2, iid: 13, type: '23', value: 'Living Room Lamp' },
          ],
        },
      ],
    },
    {
      aid: 5,
      services: [
        {
          iid: 20, type: '8C', characteristics: [
            { aid: 5, iid: 21, type: '23', value: 'Bedroom Shade' },
            { aid: 5, iid: 22, type: '6D', value: 30 },
            { aid: 5, iid: 23, type: '7C', value: 30 },
          ],
        },
      ],
    },
  ],
};

describe('DV-14 Lutron via HAP (mock session)', () => {
  it('maps the accessory DB onto lights + shades', () => {
    const devices = mapLutronDevices(HAP_DB.accessories);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({ aid: 2, kind: 'light', name: 'Living Room Lamp', on: false, brightness: 50 });
    expect(devices[1]).toMatchObject({ aid: 5, kind: 'shade', name: 'Bedroom Shade', position: 30 });
  });
  it('writes characteristics with HAP request shapes (PUT /characteristics)', async () => {
    const sent: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: HapTransport = async (req) => {
      sent.push(req);
      if (req.method === 'GET') return { status: 200, body: HAP_DB };
      return { status: 204, body: null };
    };
    const bridge = new LutronHapBridge(new HapClient(transport));
    await bridge.setLight(2, { on: true, brightness: 80 });
    await bridge.setShadePosition(5, 120); // clamps to 100
    expect(sent.filter((s) => s.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/characteristics', body: { characteristics: [{ aid: 2, iid: 11, value: true }] } },
      { method: 'PUT', path: '/characteristics', body: { characteristics: [{ aid: 2, iid: 12, value: 80 }] } },
      { method: 'PUT', path: '/characteristics', body: { characteristics: [{ aid: 5, iid: 23, value: 100 }] } },
    ]);
  });
  it('207 multi-status failures and missing characteristics raise HapError', async () => {
    const transport: HapTransport = async (req) => {
      if (req.method === 'GET') return { status: 200, body: HAP_DB };
      return { status: 207, body: { characteristics: [{ aid: 2, iid: 11, status: -70402 }] } };
    };
    const bridge = new LutronHapBridge(new HapClient(transport));
    await expect(bridge.setLight(2, { on: true })).rejects.toThrow(/-70402/);
    await expect(bridge.setShadePosition(2, 50)).rejects.toThrow(/no shade/);
  });
  it('pairing refuses honestly (hardware-gated); tool is approval-gated', async () => {
    const hap = new HapClient(async () => ({ status: 200, body: HAP_DB }));
    await expect(hap.pairSetup('123-45-678')).rejects.toBeInstanceOf(HapPairingError);
    await expect(hap.pairSetup('123-45-678')).rejects.toThrow(/hardware-gated/);
    expect(lutronHapPolicyRules()[0]!.effect).toBe('require-approval');
    const tools = createLutronHapTools({ createBridge: () => new LutronHapBridge(hap) });
    const out = (await tools[0]!.handler({ action: 'list' }, ctx)) as { result: unknown[] };
    expect(out.result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- DV-16

function ippResponse(statusCode: number, groups: Array<[number, IppAttribute[]]>, requestId = 1): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt8(1, 0);
  head.writeUInt8(1, 1);
  head.writeUInt16BE(statusCode, 2);
  head.writeInt32BE(requestId, 4);
  return Buffer.concat([head, ...groups.map(([tag, attrs]) => encodeIppGroup(tag, attrs)), Buffer.from([IPP_TAG.endOfAttributes])]);
}

describe('DV-16 IPP wire encoding', () => {
  it('builds a Get-Printer-Attributes request with the right header + op attributes', () => {
    const req = buildIppRequest({
      operationId: IPP_OP.getPrinterAttributes,
      requestId: 7,
      operationAttributes: operationAttributes('ipp://printer.local/ipp/print'),
    });
    expect(req[0]).toBe(1);
    expect(req[1]).toBe(1);
    expect(req.readUInt16BE(2)).toBe(0x000b);
    expect(req.readInt32BE(4)).toBe(7);
    expect(req[8]).toBe(IPP_TAG.operationAttributes);
    expect(req.subarray(0, req.length).includes(Buffer.from('attributes-charset'))).toBe(true);
    expect(req[req.length - 1]).toBe(IPP_TAG.endOfAttributes);
    // Charset attribute: tag 0x47, name-len 18, value 'utf-8'.
    const idx = req.indexOf('attributes-charset');
    expect(req[idx - 3]).toBe(IPP_VALUE_TAG.charset);
    expect(req.readUInt16BE(idx + 18)).toBe(5);
    expect(req.subarray(idx + 20, idx + 25).toString()).toBe('utf-8');
  });
  it('Print-Job appends document bytes verbatim after end-of-attributes', () => {
    const doc = Buffer.from('%PDF-1.4 fake');
    const req = buildIppRequest({
      operationId: IPP_OP.printJob,
      requestId: 1,
      operationAttributes: operationAttributes('http://p:631/ipp/print'),
      jobAttributes: [{ name: 'job-name', valueTag: IPP_VALUE_TAG.nameWithoutLanguage, value: 'Report' }],
      document: doc,
    });
    expect(req.subarray(req.length - doc.length).equals(doc)).toBe(true);
    expect(req[req.length - doc.length - 1]).toBe(IPP_TAG.endOfAttributes);
    expect(req.readUInt16BE(2)).toBe(0x0002);
  });
});

describe('DV-16 IPP client (mock transport)', () => {
  it('parses printer status (state enum, reasons, queued jobs)', async () => {
    const response = ippResponse(0x0000, [
      [IPP_TAG.printerAttributes, [
        { name: 'printer-state', valueTag: IPP_VALUE_TAG.enum, value: 3 },
        { name: 'printer-state-reasons', valueTag: IPP_VALUE_TAG.keyword, value: 'media-empty' },
        { name: 'queued-job-count', valueTag: IPP_VALUE_TAG.integer, value: 2 },
        { name: 'printer-is-accepting-jobs', valueTag: IPP_VALUE_TAG.boolean, value: true },
      ]],
    ]);
    let sentUrl = '';
    const client = new IppClient(async (url) => { sentUrl = url; return response; });
    const status = await client.getPrinterStatus('http://printer.local:631/ipp/print');
    expect(sentUrl).toBe('http://printer.local:631/ipp/print');
    expect(status).toMatchObject({ state: 'idle', stateReasons: ['media-empty'], queuedJobs: 2, acceptingJobs: true, statusText: 'successful-ok' });
    expect(IppClient.printerUrl('printer.local')).toBe('http://printer.local:631/ipp/print');
  });
  it('print job returns job id/state; multi-valued attributes parse as arrays', async () => {
    const response = ippResponse(0x0000, [
      [IPP_TAG.jobAttributes, [
        { name: 'job-id', valueTag: IPP_VALUE_TAG.integer, value: 42 },
        { name: 'job-uri', valueTag: IPP_VALUE_TAG.uri, value: 'ipp://p/jobs/42' },
        { name: 'job-state', valueTag: IPP_VALUE_TAG.enum, value: 5 },
      ]],
    ]);
    const client = new IppClient(async () => response);
    const out = await client.printJob({ printerUri: 'http://p:631/ipp/print', jobName: 'Doc', document: Buffer.from('hello') });
    expect(out).toMatchObject({ jobId: 42, jobUri: 'ipp://p/jobs/42', jobState: 'processing' });
    const parsed = parseIppResponse(response);
    expect(parsed.groups['job']?.['job-id']).toEqual([42]);
    expect(ippStatusText(0x0406)).toBe('client-error-not-accepting-jobs');
    expect(ippPolicyRules()[0]!.effect).toBe('require-approval');
  });
});
