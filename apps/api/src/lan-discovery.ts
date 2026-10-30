// SPDX-License-Identifier: Apache-2.0
// LAN discovery from the user's own machine (Muse parity audit §4.14,
// DV-12): mDNS (RFC 6762) + SSDP/UPnP discovery with vendor identification.
//
// Both transports are injectable — tests drive the service with mock
// transports and zero network. The production transports are real:
//   - SSDP: a UDP M-SEARCH multicast to 239.255.255.250:1900, parsing the
//     HTTPU responses (ST / SERVER / LOCATION / USN headers).
//   - mDNS: a UDP query to 224.0.0.251:5353 with a hand-rolled DNS wire
//     codec below (PTR browse → SRV/TXT/A resolution from the same
//     response's additional records), parsing name compression correctly.
//
// Discovery is read-only: it asks the LAN who is there; it never connects
// to, authenticates with, or changes any device. Control goes through the
// DV-13 proxy with its per-host approval.

import { createSocket, type Socket } from 'node:dgram';
import type { ToolDefinition } from '@mvp/agent-runtime';

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface DiscoveredDevice {
  name: string;
  host: string;
  port?: number;
  via: 'mdns' | 'ssdp';
  /** mDNS service type (e.g. "_http._tcp") or SSDP search target (ST). */
  service?: string;
  vendor?: string;
  model?: string;
  txt?: Record<string, string>;
  usn?: string;
  location?: string;
}

// ---------------------------------------------------------------------------
// Vendor identification (pure, unit-tested)
// ---------------------------------------------------------------------------

const VENDOR_HINTS: Array<{ re: RegExp; vendor: string }> = [
  { re: /shelly/i, vendor: 'Shelly (Allterco Robotics)' },
  { re: /lutron/i, vendor: 'Lutron' },
  { re: /philips|hue/i, vendor: 'Signify (Philips Hue)' },
  { re: /sonos/i, vendor: 'Sonos' },
  { re: /roku/i, vendor: 'Roku' },
  { re: /samsung/i, vendor: 'Samsung' },
  { re: /lg electronics|webos/i, vendor: 'LG' },
  { re: /apple|airport|homepod|appletv/i, vendor: 'Apple' },
  { re: /google|chromecast|nest/i, vendor: 'Google' },
  { re: /amazon|echo|alexa/i, vendor: 'Amazon' },
  { re: /brother/i, vendor: 'Brother' },
  { re: /hewlett|hp inc|hplip/i, vendor: 'HP' },
  { re: /epson/i, vendor: 'Epson' },
  { re: /canon/i, vendor: 'Canon' },
  { re: /synology/i, vendor: 'Synology' },
  { re: /fritz/i, vendor: 'AVM (FRITZ!Box)' },
  { re: /tplink|tp-link|kasa|tapo/i, vendor: 'TP-Link' },
  { re: /espressif|esp32|esp8266/i, vendor: 'Espressif device' },
  { re: /raspberry/i, vendor: 'Raspberry Pi' },
];

export function identifyVendor(...texts: Array<string | undefined>): string | undefined {
  const hay = texts.filter(Boolean).join(' ');
  if (!hay) return undefined;
  for (const hint of VENDOR_HINTS) if (hint.re.test(hay)) return hint.vendor;
  return undefined;
}

// ---------------------------------------------------------------------------
// SSDP
// ---------------------------------------------------------------------------

export interface SsdpResponse {
  host: string;
  st?: string;
  server?: string;
  location?: string;
  usn?: string;
  headers: Record<string, string>;
}

export interface SsdpTransport {
  search(searchTarget: string, timeoutMs: number): Promise<SsdpResponse[]>;
}

/** Parse one HTTPU response datagram into an SsdpResponse (pure). */
export function parseSsdpResponse(text: string, host: string): SsdpResponse | null {
  if (!/^HTTP\/1\.[01] 200/i.test(text)) return null;
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return {
    host,
    st: headers['st'],
    server: headers['server'],
    location: headers['location'],
    usn: headers['usn'],
    headers,
  };
}

export function buildMSearch(searchTarget: string, mx = 2): string {
  return [
    'M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'MAN: "ssdp:discover"',
    `MX: ${mx}`,
    `ST: ${searchTarget}`,
    '',
    '',
  ].join('\r\n');
}

/** Production SSDP transport: one multicast M-SEARCH, collects responses until the timeout. */
export function createUdpSsdpTransport(): SsdpTransport {
  return {
    search(searchTarget, timeoutMs) {
      return new Promise((resolve) => {
        const socket: Socket = createSocket({ type: 'udp4', reuseAddr: true });
        const byKey = new Map<string, SsdpResponse>();
        const done = () => {
          try { socket.close(); } catch { /* ignore */ }
          resolve([...byKey.values()]);
        };
        const timer = setTimeout(done, Math.max(100, timeoutMs));
        socket.on('error', () => { clearTimeout(timer); done(); });
        socket.on('message', (msg, rinfo) => {
          const parsed = parseSsdpResponse(msg.toString('utf8'), rinfo.address);
          if (parsed) byKey.set(`${parsed.host}|${parsed.usn ?? parsed.st ?? ''}`, parsed);
        });
        socket.bind(() => {
          try {
            const payload = Buffer.from(buildMSearch(searchTarget), 'utf8');
            socket.send(payload, 0, payload.length, 1900, '239.255.255.250');
          } catch { clearTimeout(timer); done(); }
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// mDNS / DNS wire codec
// ---------------------------------------------------------------------------

export function encodeDnsName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.').filter(Boolean);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const b = Buffer.from(part, 'utf8');
    if (b.length > 63) throw new Error('DNS label too long');
    chunks.push(Buffer.from([b.length]), b);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

export function buildDnsQuery(name: string, qtype: number, id = 0): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(0x0000, 2); // standard query, no recursion-desired on multicast
  header.writeUInt16BE(1, 4); // QDCOUNT
  const q = Buffer.alloc(4);
  q.writeUInt16BE(qtype, 0);
  q.writeUInt16BE(0x8001, 2); // QCLASS IN + QU (unicast-response) bit
  return Buffer.concat([header, encodeDnsName(name), q]);
}

/** Decode a (possibly compressed) DNS name at `offset`. Returns name + next offset. */
export function decodeDnsName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  let hops = 0;
  while (pos < buf.length) {
    const len = buf[pos] as number;
    if (len === 0) {
      if (next === -1) next = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) break;
      const ptr = ((len & 0x3f) << 8) | (buf[pos + 1] as number);
      if (next === -1) next = pos + 2;
      pos = ptr;
      if (++hops > 32) break; // compression loop guard
      continue;
    }
    const start = pos + 1;
    labels.push(buf.subarray(start, Math.min(buf.length, start + len)).toString('utf8'));
    pos = start + len;
  }
  return { name: labels.join('.'), next: next === -1 ? pos : next };
}

export interface DnsRecord {
  name: string;
  type: number;
  ttl: number;
  /** PTR target / SRV target host. */
  target?: string;
  port?: number;
  /** A record address. */
  address?: string;
  /** TXT key=value pairs. */
  txt?: Record<string, string>;
  text?: string;
}

export const DNS_TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, AAAA: 28 } as const;

/** Parse a full DNS message's answer/authority/additional records (pure). */
export function parseDnsMessage(buf: Buffer): DnsRecord[] {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const counts = [buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)];
  let pos = 12;
  for (let i = 0; i < qd; i++) {
    const { next } = decodeDnsName(buf, pos);
    pos = next + 4;
    if (pos > buf.length) return [];
  }
  const records: DnsRecord[] = [];
  const total = counts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < total && pos + 10 <= buf.length; i++) {
    const { name, next } = decodeDnsName(buf, pos);
    pos = next;
    if (pos + 10 > buf.length) break;
    const type = buf.readUInt16BE(pos);
    const ttl = buf.readUInt32BE(pos + 4);
    const rdlen = buf.readUInt16BE(pos + 8);
    const rdataStart = pos + 10;
    const rdataEnd = Math.min(buf.length, rdataStart + rdlen);
    const rec: DnsRecord = { name, type, ttl };
    if (type === DNS_TYPE.PTR && rdataStart < buf.length) {
      rec.target = decodeDnsName(buf, rdataStart).name;
    } else if (type === DNS_TYPE.SRV && rdataStart + 6 <= buf.length) {
      rec.port = buf.readUInt16BE(rdataStart + 4);
      rec.target = decodeDnsName(buf, rdataStart + 6).name;
    } else if (type === DNS_TYPE.A && rdlen === 4) {
      rec.address = [...buf.subarray(rdataStart, rdataStart + 4)].join('.');
    } else if (type === DNS_TYPE.TXT) {
      const txt: Record<string, string> = {};
      let p = rdataStart;
      while (p < rdataEnd) {
        const len = buf[p] as number;
        const s = buf.subarray(p + 1, Math.min(rdataEnd, p + 1 + len)).toString('utf8');
        const eq = s.indexOf('=');
        if (eq > 0) txt[s.slice(0, eq)] = s.slice(eq + 1);
        else if (s) txt[s] = '';
        p += 1 + len;
      }
      rec.txt = txt;
    }
    records.push(rec);
    pos = rdataStart + rdlen;
  }
  return records;
}

export interface MdnsServiceInstance {
  instance: string;
  host?: string;
  port?: number;
  txt?: Record<string, string>;
}

export interface MdnsTransport {
  browse(serviceType: string, timeoutMs: number): Promise<MdnsServiceInstance[]>;
}

/** Fold parsed DNS records into service instances for one browsed type (pure). */
export function foldMdnsRecords(serviceType: string, records: DnsRecord[]): MdnsServiceInstance[] {
  const instances = new Map<string, MdnsServiceInstance>();
  const srvByInstance = new Map<string, DnsRecord>();
  const txtByInstance = new Map<string, Record<string, string>>();
  const addrByHost = new Map<string, string>();
  for (const r of records) {
    if (r.type === DNS_TYPE.A && r.address) addrByHost.set(r.name, r.address);
    if (r.type === DNS_TYPE.SRV) srvByInstance.set(r.name, r);
    if (r.type === DNS_TYPE.TXT && r.txt) txtByInstance.set(r.name, r.txt);
  }
  for (const r of records) {
    if (r.type !== DNS_TYPE.PTR || r.name !== serviceType || !r.target) continue;
    const srv = srvByInstance.get(r.target);
    const hostName = srv?.target;
    instances.set(r.target, {
      instance: r.target,
      host: hostName ? addrByHost.get(hostName) ?? hostName : undefined,
      port: srv?.port,
      txt: txtByInstance.get(r.target),
    });
  }
  return [...instances.values()];
}

/** Production mDNS transport: PTR query to the multicast group, records folded on timeout. */
export function createUdpMdnsTransport(): MdnsTransport {
  return {
    browse(serviceType, timeoutMs) {
      return new Promise((resolve) => {
        const fqdn = serviceType.endsWith('.local') ? serviceType : `${serviceType}.local`;
        const socket: Socket = createSocket({ type: 'udp4', reuseAddr: true });
        const records: DnsRecord[] = [];
        const done = () => {
          try { socket.close(); } catch { /* ignore */ }
          resolve(foldMdnsRecords(fqdn, records));
        };
        const timer = setTimeout(done, Math.max(100, timeoutMs));
        socket.on('error', () => { clearTimeout(timer); done(); });
        socket.on('message', (msg) => {
          try { records.push(...parseDnsMessage(msg)); } catch { /* ignore malformed */ }
        });
        socket.bind(0, () => {
          try {
            socket.addMembership('224.0.0.251');
          } catch { /* membership is best-effort; responses still arrive via QU bit */ }
          try {
            const payload = buildDnsQuery(fqdn, DNS_TYPE.PTR);
            socket.send(payload, 0, payload.length, 5353, '224.0.0.251');
          } catch { clearTimeout(timer); done(); }
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Discovery service
// ---------------------------------------------------------------------------

export const DEFAULT_SSDP_TARGETS = ['ssdp:all', 'urn:schemas-upnp-org:device:MediaRenderer:1', 'urn:schemas-upnp-org:device:MediaServer:1'];
export const DEFAULT_MDNS_SERVICES = ['_http._tcp', '_printer._tcp', '_ipp._tcp', '_airplay._tcp', '_googlecast._tcp', '_homekit._tcp', '_hap._tcp', '_shelly._tcp'];

export interface LanDiscoveryDeps {
  ssdp?: SsdpTransport;
  mdns?: MdnsTransport;
}

export class LanDiscoveryService {
  private readonly ssdp: SsdpTransport;
  private readonly mdns: MdnsTransport;

  constructor(deps: LanDiscoveryDeps = {}) {
    this.ssdp = deps.ssdp ?? createUdpSsdpTransport();
    this.mdns = deps.mdns ?? createUdpMdnsTransport();
  }

  async discover(opts: {
    ssdpTargets?: string[];
    mdnsServices?: string[];
    timeoutMs?: number;
  } = {}): Promise<{ devices: DiscoveredDevice[]; errors: string[] }> {
    const timeoutMs = Math.max(200, Math.min(30_000, opts.timeoutMs ?? 3000));
    const devices: DiscoveredDevice[] = [];
    const errors: string[] = [];
    const jobs: Array<Promise<void>> = [];

    for (const st of opts.ssdpTargets ?? DEFAULT_SSDP_TARGETS) {
      jobs.push(
        this.ssdp.search(st, timeoutMs).then((responses) => {
          for (const r of responses) {
            devices.push({
              name: r.usn ?? r.st ?? r.host,
              host: r.host,
              via: 'ssdp',
              service: r.st,
              vendor: identifyVendor(r.server, r.st, r.usn),
              usn: r.usn,
              location: r.location,
            });
          }
        }).catch((e: unknown) => { errors.push(`ssdp ${st}: ${e instanceof Error ? e.message : String(e)}`); }),
      );
    }
    for (const svc of opts.mdnsServices ?? DEFAULT_MDNS_SERVICES) {
      jobs.push(
        this.mdns.browse(svc, timeoutMs).then((instances) => {
          for (const inst of instances) {
            const label = inst.instance.replace(new RegExp(`\\.${escapeRe(svc)}\\.(local\\.)?$`), '');
            devices.push({
              name: label || inst.instance,
              host: inst.host ?? '',
              port: inst.port,
              via: 'mdns',
              service: svc,
              vendor: identifyVendor(inst.txt?.['md'], inst.txt?.['fn'], inst.txt?.['manufacturer'], label),
              model: inst.txt?.['md'] ?? inst.txt?.['model'],
              txt: inst.txt,
            });
          }
        }).catch((e: unknown) => { errors.push(`mdns ${svc}: ${e instanceof Error ? e.message : String(e)}`); }),
      );
    }
    await Promise.all(jobs);
    // Dedupe by host+service+name (SSDP answers the same device for many STs).
    const seen = new Set<string>();
    const deduped = devices.filter((d) => {
      if (!d.host) return false;
      const key = `${d.host}|${d.port ?? ''}|${d.service ?? ''}|${d.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.sort((a, b) => a.host.localeCompare(b.host) || a.name.localeCompare(b.name));
    return { devices: deduped, errors };
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Tool + routes (register-style)
// ---------------------------------------------------------------------------

export function createLanDiscoveryTools(deps: { service: LanDiscoveryService }): ToolDefinition[] {
  return [
    {
      name: 'lan_discover_devices',
      description:
        'Discover devices and services on the user\'s own local network via mDNS + SSDP (read-only; identifies vendors where the protocols reveal them). Control of any found device goes through the approval-gated home proxy, never through discovery.',
      parameters: {
        type: 'object',
        properties: {
          timeoutMs: { type: 'number', description: 'Per-protocol listen window in ms (200-30000, default 3000)' },
          mdnsServices: { type: 'array', items: { type: 'string' }, description: 'Optional mDNS service types to browse (default set covers http/printer/airplay/cast/homekit/shelly)' },
          ssdpTargets: { type: 'array', items: { type: 'string' }, description: 'Optional SSDP search targets (default ssdp:all + media devices)' },
        },
        required: [],
        additionalProperties: false,
      },
      handler: async (args) => {
        const strings = (v: unknown): string[] | undefined =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 128) : undefined;
        return deps.service.discover({
          timeoutMs: typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : undefined,
          mdnsServices: strings(args['mdnsServices']),
          ssdpTargets: strings(args['ssdpTargets']),
        });
      },
    } satisfies ToolDefinition,
  ];
}

export function registerLanDiscoveryTools(registry: Map<string, ToolDefinition>, deps: { service: LanDiscoveryService }): void {
  for (const tool of createLanDiscoveryTools(deps)) {
    if (!registry.has(tool.name)) registry.set(tool.name, tool);
  }
}
