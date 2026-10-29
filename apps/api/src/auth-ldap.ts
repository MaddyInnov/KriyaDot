// SPDX-License-Identifier: Apache-2.0
// Minimal LDAP client (original code, hand-rolled BER over node:net/tls).
//
// Supports the two classic login patterns:
//   - bind-DN template:  dn = template with {username} substituted, bind.
//   - search-then-bind:  bind as a service account (or anonymous), search
//     `searchBase` with `searchFilter` ({username} substituted, RFC 4515
//     escaped), take the first entry's DN, then bind as that DN on a fresh
//     connection with the user's password.
// No third-party LDAP library is used; BER TLV encoding/decoding below is
// implemented from RFC 4511 / X.690 basics only.

import net from 'node:net';
import tls from 'node:tls';

// ---------------------------------------------------------------------------
// BER primitives (exported for reuse + for the in-process fake server tests)
// ---------------------------------------------------------------------------

export function berEncodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function berTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), berEncodeLength(content.length), content]);
}

export function berInteger(value: number): Buffer {
  const bytes: number[] = [];
  let n = value;
  if (n === 0) bytes.push(0);
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return berTlv(0x02, Buffer.from(bytes));
}

export function berEnumerated(value: number): Buffer {
  const inner = berInteger(value).subarray(2);
  return berTlv(0x0a, inner);
}

export function berOctetString(value: string | Buffer): Buffer {
  return berTlv(0x04, typeof value === 'string' ? Buffer.from(value, 'utf8') : value);
}

export function berBoolean(value: boolean): Buffer {
  return berTlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}

export function berSequence(content: Buffer, tag = 0x30): Buffer {
  return berTlv(tag, content);
}

export interface BerElement {
  tag: number;
  /** Raw content bytes (between header and end). */
  value: Buffer;
  children: BerElement[];
  totalLength: number;
}

/** Parse one BER element at `offset`. Constructed tags get children parsed. */
export function berParse(buf: Buffer, offset = 0): BerElement {
  if (offset + 2 > buf.length) throw new Error('BER: truncated header');
  const tag = buf[offset]!;
  let pos = offset + 1;
  const firstLen = buf[pos]!;
  pos += 1;
  let length: number;
  if (firstLen & 0x80) {
    const nBytes = firstLen & 0x7f;
    if (nBytes === 0 || pos + nBytes > buf.length) throw new Error('BER: bad long-form length');
    length = 0;
    for (let i = 0; i < nBytes; i++) length = length * 256 + buf[pos + i]!;
    pos += nBytes;
  } else {
    length = firstLen;
  }
  if (pos + length > buf.length) throw new Error('BER: truncated value');
  const value = buf.subarray(pos, pos + length);
  const children: BerElement[] = [];
  if (tag & 0x20) {
    let childPos = 0;
    while (childPos < value.length) {
      const child = berParse(value, childPos);
      children.push(child);
      childPos += child.totalLength;
    }
  }
  return { tag, value, children, totalLength: pos - offset + length };
}

/** Length of a complete element at offset, or -1 when more bytes are needed. */
export function berCompleteLength(buf: Buffer, offset = 0): number {
  try {
    return berParse(buf, offset).totalLength;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// LDAP message construction (RFC 4511)
// ---------------------------------------------------------------------------

export function encodeBindRequest(messageId: number, dn: string, password: string): Buffer {
  const auth = berTlv(0x80, Buffer.from(password, 'utf8')); // simple auth [0]
  const op = berSequence(Buffer.concat([berInteger(3), berOctetString(dn), auth]), 0x60);
  return berSequence(Buffer.concat([berInteger(messageId), op]));
}

function encodeFilter(filter: string): Buffer {
  // Supports a single equality `(attr=value)` or present `(attr=*)` clause —
  // enough for login filters like (uid=alice) / (mail=alice@example.com).
  const m = /^\(([^=()]+)=([^()]*)\)$/.exec(filter.trim());
  if (!m) throw new Error(`unsupported LDAP filter "${filter}" (single equality/present clause only)`);
  const attr = m[1]!;
  const value = m[2]!;
  if (value === '*') return berTlv(0x87, Buffer.from(attr, 'utf8')); // present [7]
  return berSequence(Buffer.concat([berOctetString(attr), berOctetString(value)]), 0xa3); // equalityMatch [3]
}

export function encodeSearchRequest(messageId: number, base: string, filter: string): Buffer {
  const op = berSequence(
    Buffer.concat([
      berOctetString(base),
      berEnumerated(2), // wholeSubtree
      berEnumerated(0), // neverDerefAliases
      berInteger(0),
      berInteger(0),
      berBoolean(false),
      encodeFilter(filter),
      berSequence(Buffer.alloc(0)), // no attributes requested (DN is what we need)
    ]),
    0x63,
  );
  return berSequence(Buffer.concat([berInteger(messageId), op]));
}

export function ldapEscapeFilterValue(value: string): string {
  return value.replace(/[*()\\\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface LdapConfig {
  /** ldap://host:port or ldaps://host:port */
  url: string;
  bindDnTemplate?: string;
  searchBase?: string;
  /** Default '(uid={username})'. */
  searchFilter?: string;
  serviceDn?: string;
  servicePassword?: string;
  timeoutMs?: number;
}

export function ldapConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LdapConfig | null {
  const url = env.KRIYADOT_LDAP_URL;
  if (!url) return null;
  return {
    url,
    bindDnTemplate: env.KRIYADOT_LDAP_BIND_DN_TEMPLATE || undefined,
    searchBase: env.KRIYADOT_LDAP_SEARCH_BASE || undefined,
    searchFilter: env.KRIYADOT_LDAP_SEARCH_FILTER || undefined,
    serviceDn: env.KRIYADOT_LDAP_SERVICE_DN || undefined,
    servicePassword: env.KRIYADOT_LDAP_SERVICE_PASSWORD || undefined,
  };
}

export type LdapAuthResult =
  | { ok: true; dn: string; username: string }
  | { ok: false; reason: 'bad-password' | 'user-not-found' | 'error'; detail?: string };

class LdapConnection {
  private buffer = Buffer.alloc(0);
  private waiters: Array<{ resolve: (el: BerElement) => void; reject: (e: Error) => void }> = [];
  private nextId = 1;
  private readonly socket: net.Socket;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    socket.on('error', (err) => this.failAll(err));
    socket.on('close', () => this.failAll(new Error('LDAP connection closed')));
  }

  static connect(config: LdapConfig): Promise<LdapConnection> {
    const url = new URL(config.url);
    const port = Number(url.port || (url.protocol === 'ldaps:' ? 636 : 389));
    const host = url.hostname;
    const timeout = config.timeoutMs ?? 5000;
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      const socket =
        url.protocol === 'ldaps:'
          ? tls.connect({ host, port, servername: host }, () => done())
          : net.connect({ host, port }, () => done());
      socket.setTimeout(timeout, () => {
        socket.destroy();
        reject(new Error('LDAP connection timed out'));
      });
      const done = () => {
        socket.off('error', onError);
        resolve(new LdapConnection(socket));
      };
      socket.once('error', onError);
    });
  }

  private failAll(err: Error): void {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  private pump(): void {
    while (this.waiters.length > 0) {
      const len = berCompleteLength(this.buffer, 0);
      if (len < 0 || this.buffer.length < len) return;
      const el = berParse(this.buffer, 0);
      this.buffer = this.buffer.subarray(len);
      const waiter = this.waiters.shift()!;
      waiter.resolve(el);
    }
  }

  /** Send a request and await the next response message. */
  request(payload: (messageId: number) => Buffer): Promise<BerElement> {
    const id = this.nextId++;
    const msg = payload(id);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.socket.write(msg);
      // Responses may already be in the buffer (pipelined server replies).
      this.pump();
    });
  }

  /** Await another message (e.g. SearchResultDone after entries). */
  nextMessage(): Promise<BerElement> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.pump();
    });
  }

  close(): void {
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
  }
}

function resultCodeOf(message: BerElement): number {
  // LDAPMessage → protocolOp → first child is the resultCode ENUMERATED.
  const op = message.children[1];
  const code = op?.children[0];
  return code && code.value.length > 0 ? code.value[code.value.length - 1]! : -1;
}

async function bindOnce(config: LdapConfig, dn: string, password: string): Promise<number> {
  const conn = await LdapConnection.connect(config);
  try {
    const res = await conn.request((id) => encodeBindRequest(id, dn, password));
    return resultCodeOf(res);
  } finally {
    conn.close();
  }
}

export class LdapClient {
  constructor(readonly config: LdapConfig) {}

  async authenticate(username: string, password: string): Promise<LdapAuthResult> {
    try {
      if (!username || !password) return { ok: false, reason: 'bad-password' };
      if (this.config.bindDnTemplate) {
        const dn = this.config.bindDnTemplate.replaceAll('{username}', username);
        const code = await bindOnce(this.config, dn, password);
        return code === 0 ? { ok: true, dn, username } : { ok: false, reason: 'bad-password', detail: `LDAP result ${code}` };
      }
      // Search-then-bind.
      const base = this.config.searchBase;
      if (!base) return { ok: false, reason: 'error', detail: 'LDAP config needs bindDnTemplate or searchBase' };
      const filter = (this.config.searchFilter ?? '(uid={username})').replaceAll(
        '{username}',
        ldapEscapeFilterValue(username),
      );
      const conn = await LdapConnection.connect(this.config);
      let entryDn: string | undefined;
      try {
        const bindRes = await conn.request((id) =>
          encodeBindRequest(id, this.config.serviceDn ?? '', this.config.servicePassword ?? ''),
        );
        if (resultCodeOf(bindRes) !== 0) return { ok: false, reason: 'error', detail: 'service bind failed' };
        const first = await conn.request((id) => encodeSearchRequest(id, base, filter));
        let msg = first;
        for (let i = 0; i < 50; i++) {
          const op = msg.children[1];
          if (op?.tag === 0x64) {
            // SearchResultEntry: first child is the entry DN octet string.
            entryDn = op.children[0]?.value.toString('utf8');
            msg = await conn.nextMessage();
            continue;
          }
          break; // SearchResultDone (0x65) or an error response
        }
      } finally {
        conn.close();
      }
      if (!entryDn) return { ok: false, reason: 'user-not-found' };
      const code = await bindOnce(this.config, entryDn, password);
      return code === 0
        ? { ok: true, dn: entryDn, username }
        : { ok: false, reason: 'bad-password', detail: `LDAP result ${code}` };
    } catch (err) {
      return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
