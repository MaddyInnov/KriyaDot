// SPDX-License-Identifier: Apache-2.0
// Network printing via IPP (Internet Printing Protocol, RFC 8010/8011)
// (Muse parity audit §4.14, DV-16).
//
// This is a real IPP/1.1 client, not a shell-out to CUPS:
//   - buildIppRequest() encodes the binary wire format by hand —
//     version(2) | operation-id(2) | request-id(4) | attribute groups
//     (delimiter tags 0x01/0x02/0x04, end 0x03) with typed values
//     (charset 0x47, naturalLanguage 0x48, uri 0x45, keyword 0x44,
//     nameWithoutLanguage 0x42, mimeMediaType 0x49, integer 0x21,
//     enum 0x23, boolean 0x22).
//   - parseIppResponse() decodes status + attribute groups back.
//   - Operations: Get-Printer-Attributes (0x000B), Print-Job (0x0002,
//     document bytes appended after the attribute section).
//
// Transport is injectable: (url, bytes) → response bytes. Production uses
// an HTTP POST with Content-Type application/ipp (default below, or the
// DV-13 home proxy transport so first contact with the printer host rides
// the per-host approval grant).
//
// Governance: printing consumes paper/ink on a physical device →
// require-approval for ipp_print; status reads are unopinionated reads and
// carry no policy rule.

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import { PAUSED_MESSAGE } from './system-pause.js';

export function ippPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'ipp-print-approval',
      toolPattern: '^ipp_print$',
      effect: 'require-approval',
      reason:
        'Printing sends a document to a physical network printer (paper/ink, and the document leaves as hard copy); needs human approval. The approval card names the printer and document.',
    },
  ];
}

// ---------------------------------------------------------------------------
// IPP wire encoding
// ---------------------------------------------------------------------------

export const IPP_OP = { printJob: 0x0002, getPrinterAttributes: 0x000b, getJobs: 0x000a } as const;
export const IPP_TAG = {
  operationAttributes: 0x01,
  jobAttributes: 0x02,
  endOfAttributes: 0x03,
  printerAttributes: 0x04,
  unsupportedAttributes: 0x05,
} as const;
export const IPP_VALUE_TAG = {
  unsupported: 0x10,
  unknown: 0x12,
  noValue: 0x13,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  dateTime: 0x31,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
  nameWithoutLanguage: 0x42,
  textWithoutLanguage: 0x41,
} as const;

export interface IppAttribute {
  name: string;
  valueTag: number;
  value: string | number | boolean;
}

function encodeValue(tag: number, value: string | number | boolean): Buffer {
  switch (tag) {
    case IPP_VALUE_TAG.integer:
    case IPP_VALUE_TAG.enum: {
      const b = Buffer.alloc(4);
      b.writeInt32BE(Number(value), 0);
      return b;
    }
    case IPP_VALUE_TAG.boolean:
      return Buffer.from([value ? 1 : 0]);
    case IPP_VALUE_TAG.dateTime:
      return Buffer.from(String(value), 'utf8');
    default:
      return Buffer.from(String(value), 'utf8');
  }
}

/** Encode one attribute group (delimiter tag + attributes). */
export function encodeIppGroup(delimiter: number, attrs: IppAttribute[]): Buffer {
  const chunks: Buffer[] = [Buffer.from([delimiter])];
  for (const attr of attrs) {
    const name = Buffer.from(attr.name, 'utf8');
    const val = encodeValue(attr.valueTag, attr.value);
    const head = Buffer.alloc(1 + 2 + name.length + 2);
    head[0] = attr.valueTag;
    head.writeUInt16BE(name.length, 1);
    name.copy(head, 3);
    head.writeUInt16BE(val.length, 3 + name.length);
    chunks.push(head, val);
  }
  return Buffer.concat(chunks);
}

export interface IppRequestSpec {
  operationId: number;
  requestId: number;
  operationAttributes: IppAttribute[];
  jobAttributes?: IppAttribute[];
  /** Document bytes appended verbatim after end-of-attributes (Print-Job). */
  document?: Buffer;
}

/** Build a complete IPP request message (pure — byte-verified in tests). */
export function buildIppRequest(spec: IppRequestSpec): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt8(1, 0); // IPP version 1.1
  head.writeUInt8(1, 1);
  head.writeUInt16BE(spec.operationId, 2);
  head.writeInt32BE(spec.requestId, 4);
  const parts = [head, encodeIppGroup(IPP_TAG.operationAttributes, spec.operationAttributes)];
  if (spec.jobAttributes && spec.jobAttributes.length > 0) {
    parts.push(encodeIppGroup(IPP_TAG.jobAttributes, spec.jobAttributes));
  }
  parts.push(Buffer.from([IPP_TAG.endOfAttributes]));
  if (spec.document) parts.push(spec.document);
  return Buffer.concat(parts);
}

/** Standard operation attributes every request carries. */
export function operationAttributes(printerUri: string, requestingUser = 'kriyadot'): IppAttribute[] {
  return [
    { name: 'attributes-charset', valueTag: IPP_VALUE_TAG.charset, value: 'utf-8' },
    { name: 'attributes-natural-language', valueTag: IPP_VALUE_TAG.naturalLanguage, value: 'en' },
    { name: 'printer-uri', valueTag: IPP_VALUE_TAG.uri, value: printerUri },
    { name: 'requesting-user-name', valueTag: IPP_VALUE_TAG.nameWithoutLanguage, value: requestingUser },
  ];
}

// ---------------------------------------------------------------------------
// IPP response parsing
// ---------------------------------------------------------------------------

export interface IppResponse {
  versionMajor: number;
  versionMinor: number;
  statusCode: number;
  requestId: number;
  /** Group delimiter name → attribute name → values (multi-valued kept as arrays). */
  groups: Record<string, Record<string, Array<string | number | boolean>>>;
}

const GROUP_NAMES: Record<number, string> = {
  0x01: 'operation', 0x02: 'job', 0x04: 'printer', 0x05: 'unsupported',
};

function decodeValue(tag: number, raw: Buffer): string | number | boolean {
  switch (tag) {
    case IPP_VALUE_TAG.integer:
    case IPP_VALUE_TAG.enum:
      return raw.length === 4 ? raw.readInt32BE(0) : 0;
    case IPP_VALUE_TAG.boolean:
      return raw.length > 0 && raw[0] !== 0;
    default:
      return raw.toString('utf8');
  }
}

/** Parse an IPP response message (pure). Throws on a truncated header. */
export function parseIppResponse(buf: Buffer): IppResponse {
  if (buf.length < 8) throw new Error('IPP response too short');
  const res: IppResponse = {
    versionMajor: buf[0] as number,
    versionMinor: buf[1] as number,
    statusCode: buf.readUInt16BE(2),
    requestId: buf.readInt32BE(4),
    groups: {},
  };
  let pos = 8;
  let groupName: string | null = null;
  let lastAttr: string | null = null;
  while (pos < buf.length) {
    const tag = buf[pos] as number;
    if (tag === IPP_TAG.endOfAttributes) break;
    if (tag < 0x10) {
      groupName = GROUP_NAMES[tag] ?? `group-0x${tag.toString(16)}`;
      if (!res.groups[groupName]) res.groups[groupName] = {};
      lastAttr = null;
      pos += 1;
      continue;
    }
    // Attribute: value-tag(1) name-len(2) name value-len(2) value.
    if (pos + 3 > buf.length) break;
    const nameLen = buf.readUInt16BE(pos + 1);
    const nameStart = pos + 3;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');
    const valLenPos = nameStart + nameLen;
    if (valLenPos + 2 > buf.length) break;
    const valLen = buf.readUInt16BE(valLenPos);
    const valStart = valLenPos + 2;
    const raw = buf.subarray(valStart, Math.min(buf.length, valStart + valLen));
    pos = valStart + valLen;
    if (!groupName) continue;
    const group = res.groups[groupName] as Record<string, Array<string | number | boolean>>;
    // Empty name = additional value of the previous attribute.
    const attrName: string | null = nameLen === 0 ? lastAttr : name;
    if (!attrName) continue;
    if (!group[attrName]) group[attrName] = [];
    group[attrName].push(decodeValue(tag, raw));
    lastAttr = attrName;
  }
  return res;
}

export const IPP_STATUS_TEXT: Record<number, string> = {
  0x0000: 'successful-ok',
  0x0400: 'client-error-bad-request',
  0x0404: 'client-error-not-found',
  0x0406: 'client-error-not-accepting-jobs',
  0x0409: 'client-error-document-format-not-supported',
  0x0501: 'server-error-internal-error',
  0x0503: 'server-error-service-unavailable',
  0x0506: 'server-error-device-error',
};

export function ippStatusText(code: number): string {
  return IPP_STATUS_TEXT[code] ?? (code < 0x0100 ? 'successful' : code < 0x0600 ? `ipp-error-0x${code.toString(16)}` : `unknown-0x${code.toString(16)}`);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type IppTransport = (url: string, body: Buffer) => Promise<Buffer>;

/** Default transport: HTTP POST application/ipp via fetch, 15s cap. */
export const fetchIppTransport: IppTransport = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ipp' },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`IPP HTTP transport failed with HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

export interface PrinterStatus {
  uri: string;
  state?: 'idle' | 'processing' | 'stopped' | string;
  stateReasons: string[];
  queuedJobs?: number;
  acceptingJobs?: boolean;
  statusText: string;
}

export interface PrintJobResult {
  statusCode: number;
  statusText: string;
  jobId?: number;
  jobUri?: string;
  jobState?: string;
}

const PRINTER_STATE_ENUM: Record<number, string> = { 3: 'idle', 4: 'processing', 5: 'stopped' };

export class IppClient {
  private requestCounter = 0;

  constructor(private readonly transport: IppTransport = fetchIppTransport) {}

  private nextId(): number {
    this.requestCounter += 1;
    return this.requestCounter;
  }

  /** IPP printer URL: http://host:631/ipp/print (path configurable). */
  static printerUrl(host: string, path = '/ipp/print'): string {
    if (/^https?:\/\//i.test(host)) return host.replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`);
    const withPort = /:\d+$/.test(host) ? host : `${host}:631`;
    return `http://${withPort}${path}`;
  }

  async getPrinterStatus(printerUri: string): Promise<PrinterStatus> {
    const url = printerUri;
    const body = buildIppRequest({
      operationId: IPP_OP.getPrinterAttributes,
      requestId: this.nextId(),
      operationAttributes: operationAttributes(printerUri),
    });
    const res = parseIppResponse(await this.transport(url, body));
    const printer = res.groups['printer'] ?? {};
    const first = (name: string) => printer[name]?.[0];
    const stateEnum = first('printer-state');
    return {
      uri: printerUri,
      state: typeof stateEnum === 'number' ? PRINTER_STATE_ENUM[stateEnum] ?? `state-${stateEnum}` : undefined,
      stateReasons: (printer['printer-state-reasons'] ?? []).map(String),
      queuedJobs: typeof first('queued-job-count') === 'number' ? (first('queued-job-count') as number) : undefined,
      acceptingJobs: typeof first('printer-is-accepting-jobs') === 'boolean' ? (first('printer-is-accepting-jobs') as boolean) : undefined,
      statusText: ippStatusText(res.statusCode),
    };
  }

  async printJob(input: {
    printerUri: string;
    jobName: string;
    document: Buffer;
    mimeType?: string;
  }): Promise<PrintJobResult> {
    const body = buildIppRequest({
      operationId: IPP_OP.printJob,
      requestId: this.nextId(),
      operationAttributes: operationAttributes(input.printerUri),
      jobAttributes: [
        { name: 'job-name', valueTag: IPP_VALUE_TAG.nameWithoutLanguage, value: input.jobName },
        { name: 'document-format', valueTag: IPP_VALUE_TAG.mimeMediaType, value: input.mimeType ?? 'application/octet-stream' },
      ],
      document: input.document,
    });
    const res = parseIppResponse(await this.transport(input.printerUri, body));
    const job = res.groups['job'] ?? {};
    const first = (name: string) => job[name]?.[0];
    const jobState = first('job-state');
    return {
      statusCode: res.statusCode,
      statusText: ippStatusText(res.statusCode),
      jobId: typeof first('job-id') === 'number' ? (first('job-id') as number) : undefined,
      jobUri: typeof first('job-uri') === 'string' ? (first('job-uri') as string) : undefined,
      jobState: typeof jobState === 'number' ? ({ 3: 'pending', 4: 'pending-held', 5: 'processing', 6: 'processing-stopped', 7: 'canceled', 8: 'aborted', 9: 'completed' } as Record<number, string>)[jobState] ?? `state-${jobState}` : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface IppToolDeps {
  client: IppClient;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown; sessionId?: string }) => void;
  isPaused?: () => boolean;
}

function reqPrinterUri(args: Record<string, unknown>): string {
  const host = args['printer'];
  if (typeof host !== 'string' || !host.trim()) throw new Error('"printer" is required (host, host:port, or full IPP URL)');
  const path = typeof args['path'] === 'string' ? args['path'] : '/ipp/print';
  return IppClient.printerUrl(host.trim(), path);
}

export function createIppTools(deps: IppToolDeps): ToolDefinition[] {
  const status: ToolDefinition = {
    name: 'ipp_printer_status',
    description:
      'Read a network printer\'s status over IPP (state, state reasons like media-empty/paper-jam, queued job count, accepting-jobs). Read-only.',
    parameters: {
      type: 'object',
      properties: {
        printer: { type: 'string', description: 'Printer host, host:port, or full IPP URL' },
        path: { type: 'string', description: 'IPP path (default /ipp/print)' },
      },
      required: ['printer'],
      additionalProperties: false,
    },
    handler: async (args) => deps.client.getPrinterStatus(reqPrinterUri(args)),
  };
  const print: ToolDefinition = {
    name: 'ipp_print',
    description:
      'Print a document (base64) to a network printer over real IPP Print-Job encoding. Requires human approval.',
    parameters: {
      type: 'object',
      properties: {
        printer: { type: 'string', description: 'Printer host, host:port, or full IPP URL' },
        path: { type: 'string', description: 'IPP path (default /ipp/print)' },
        jobName: { type: 'string', description: 'Job name shown on the printer queue' },
        documentBase64: { type: 'string', description: 'Document bytes, base64-encoded' },
        mimeType: { type: 'string', description: 'Document format (e.g. application/pdf, image/jpeg, text/plain)' },
      },
      required: ['printer', 'jobName', 'documentBase64'],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext) => {
      if (deps.isPaused?.()) throw new Error(`paused: ${PAUSED_MESSAGE}`);
      const jobName = args['jobName'];
      const b64 = args['documentBase64'];
      if (typeof jobName !== 'string' || !jobName || jobName.length > 200) throw new Error('"jobName" is required (max 200 chars)');
      if (typeof b64 !== 'string' || !b64) throw new Error('"documentBase64" is required');
      const document = Buffer.from(b64, 'base64');
      if (document.length === 0) throw new Error('"documentBase64" decoded to zero bytes');
      if (document.length > 32 * 1024 * 1024) throw new Error('document too large (max 32MB)');
      const printerUri = reqPrinterUri(args);
      const result = await deps.client.printJob({
        printerUri,
        jobName,
        document,
        mimeType: typeof args['mimeType'] === 'string' ? args['mimeType'] : undefined,
      });
      try {
        deps.audit?.('ipp.print', {
          actor: ctx.botId, toolName: 'ipp_print', sessionId: ctx.sessionId,
          detail: { printerUri, jobName, bytes: document.length, statusText: result.statusText, jobId: result.jobId },
        });
      } catch { /* audit must never break the tool */ }
      if (result.statusCode >= 0x0400) throw new Error(`printer rejected the job: ${result.statusText} (0x${result.statusCode.toString(16)})`);
      return { ok: true, printerUri, ...result };
    },
  };
  return [status, print];
}

export function registerIppTools(registry: Map<string, ToolDefinition>, deps: IppToolDeps): void {
  for (const tool of createIppTools(deps)) {
    if (!registry.has(tool.name)) registry.set(tool.name, tool);
  }
}
