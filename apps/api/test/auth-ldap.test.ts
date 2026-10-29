// SPDX-License-Identifier: Apache-2.0
// LDAP tests against an in-process fake LDAP server (node:net speaking just
// enough BER to answer bind/search). Zero real network — localhost only.

import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LdapClient,
  berEnumerated,
  berInteger,
  berOctetString,
  berParse,
  berSequence,
  berCompleteLength,
  ldapEscapeFilterValue,
  type BerElement,
} from '../src/auth-ldap.js';

const DIRECTORY = new Map<string, { dn: string; password: string }>([
  ['alice', { dn: 'uid=alice,ou=people,dc=example,dc=com', password: 'wonderland' }],
  ['bob', { dn: 'uid=bob,ou=people,dc=example,dc=com', password: 'builder' }],
]);
const SERVICE_DN = 'cn=svc,dc=example,dc=com';
const SERVICE_PW = 'svc-secret';

function ldapMessage(id: number, op: Buffer): Buffer {
  return berSequence(Buffer.concat([berInteger(id), op]));
}
function resultOp(tag: number, code: number): Buffer {
  return berSequence(Buffer.concat([berEnumerated(code), berOctetString(''), berOctetString('')]), tag);
}
function entryOp(dn: string): Buffer {
  return berSequence(Buffer.concat([berOctetString(dn), berSequence(Buffer.alloc(0))]), 0x64);
}

function startFakeLdap(): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const len = berCompleteLength(buf, 0);
        if (len < 0 || buf.length < len) break;
        const msg = berParse(buf, 0);
        buf = buf.subarray(len);
        handle(msg, socket);
      }
    });
  });
  function handle(msg: BerElement, socket: net.Socket): void {
    const idEl = msg.children[0]!;
    const id = idEl.value[idEl.value.length - 1]!;
    const op = msg.children[1]!;
    if (op.tag === 0x60) {
      // BindRequest: [version, dn, auth[0]]
      const dn = op.children[1]!.value.toString('utf8');
      const pw = op.children[2]!.value.toString('utf8');
      let code = 49;
      if (dn === SERVICE_DN && pw === SERVICE_PW) code = 0;
      else if (dn === '' && pw === '') code = 0;
      else {
        for (const user of DIRECTORY.values()) if (user.dn === dn && user.password === pw) code = 0;
        // Template-mode DNs are also user DNs in this fake.
      }
      socket.write(ldapMessage(id, resultOp(0x61, code)));
      return;
    }
    if (op.tag === 0x63) {
      // SearchRequest: filter is child index 6; equality [3] → [attr, value]
      const filter = op.children[6]!;
      const value = filter.children[1]?.value.toString('utf8') ?? '';
      const user = DIRECTORY.get(value);
      if (user) socket.write(ldapMessage(id, entryOp(user.dn)));
      socket.write(ldapMessage(id, resultOp(0x65, 0)));
      return;
    }
    socket.write(ldapMessage(id, resultOp(0x61, 53)));
  }
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe('LdapClient (fake in-process server)', () => {
  let fake: { port: number; close: () => void } | undefined;
  afterEach(() => fake?.close());

  async function client(extra: object = {}): Promise<LdapClient> {
    fake = await startFakeLdap();
    return new LdapClient({
      url: `ldap://127.0.0.1:${fake.port}`,
      searchBase: 'ou=people,dc=example,dc=com',
      searchFilter: '(uid={username})',
      serviceDn: SERVICE_DN,
      servicePassword: SERVICE_PW,
      ...extra,
    });
  }

  it('search-then-bind succeeds with the right password', async () => {
    const c = await client();
    const r = await c.authenticate('alice', 'wonderland');
    expect(r).toMatchObject({ ok: true, dn: 'uid=alice,ou=people,dc=example,dc=com' });
  });

  it('rejects a bad password', async () => {
    const c = await client();
    const r = await c.authenticate('alice', 'wrong');
    expect(r).toMatchObject({ ok: false, reason: 'bad-password' });
  });

  it('reports user-not-found for unknown users', async () => {
    const c = await client();
    const r = await c.authenticate('mallory', 'whatever');
    expect(r).toMatchObject({ ok: false, reason: 'user-not-found' });
  });

  it('bind-DN template mode works', async () => {
    const c = await client({ bindDnTemplate: 'uid={username},ou=people,dc=example,dc=com', searchBase: undefined });
    expect(await c.authenticate('bob', 'builder')).toMatchObject({ ok: true });
    expect(await c.authenticate('bob', 'nope')).toMatchObject({ ok: false, reason: 'bad-password' });
  });

  it('escapes filter metacharacters (injection-safe usernames)', () => {
    expect(ldapEscapeFilterValue('a*b(c)\\d')).toBe('a\\2ab\\28c\\29\\5cd');
  });
});
