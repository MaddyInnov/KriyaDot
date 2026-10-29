// SPDX-License-Identifier: Apache-2.0
// Workspace backends: Local (tmp dirs), S3 against an in-process fake S3
// HTTP server (SigV4 shape verified), Postgres against an in-process fake
// PG wire server (startup/auth/simple-query), Composite fallthrough,
// registry parsing, traversal rejection. Zero external network.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  CompositeBackend,
  LocalBackend,
  PostgresBackend,
  S3Backend,
  WorkspacePathError,
  loadWorkspaceBackendsFromEnv,
  normalizeWorkspacePath,
  parseWorkspaceBackendsConfig,
  resolveBackendForBot,
} from '../src/workspace-backends.js';

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

describe('normalizeWorkspacePath', () => {
  it('normalizes separators and dot segments', () => {
    expect(normalizeWorkspacePath('a/./b//c.txt')).toBe('a/b/c.txt');
    expect(normalizeWorkspacePath('a/b/../c.txt')).toBe('a/c.txt');
    expect(normalizeWorkspacePath('')).toBe('');
  });
  it('rejects traversal and absolute paths', () => {
    expect(() => normalizeWorkspacePath('../secret')).toThrow(WorkspacePathError);
    expect(() => normalizeWorkspacePath('a/../../secret')).toThrow(WorkspacePathError);
    expect(() => normalizeWorkspacePath('/etc/passwd')).toThrow(WorkspacePathError);
    expect(() => normalizeWorkspacePath('a\\b')).toThrow(WorkspacePathError);
  });
});

// ---------------------------------------------------------------------------
// LocalBackend
// ---------------------------------------------------------------------------

describe('LocalBackend', () => {
  let dir: string;
  let backend: LocalBackend;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-local-'));
    backend = new LocalBackend(join(dir, 'root'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips write/read/list/stat/delete', async () => {
    await backend.write('notes/a.txt', 'hello local');
    await backend.write('notes/b.txt', Buffer.from('second'));
    expect((await backend.read('notes/a.txt')).toString()).toBe('hello local');
    expect(await backend.list('notes')).toEqual(['notes/a.txt', 'notes/b.txt']);
    expect(await backend.list('')).toEqual(['notes/a.txt', 'notes/b.txt']);
    const st = await backend.stat('notes/a.txt');
    expect(st?.size).toBe(11);
    expect(st?.exists).toBe(true);
    expect(await backend.stat('nope.txt')).toBeNull();
    await backend.delete('notes/a.txt');
    expect(await backend.list('')).toEqual(['notes/b.txt']);
    await expect(backend.read('notes/a.txt')).rejects.toThrow();
  });

  it('rejects traversal on every operation', async () => {
    await expect(backend.write('../escape.txt', 'x')).rejects.toThrow(WorkspacePathError);
    await expect(backend.read('../../etc/passwd')).rejects.toThrow(WorkspacePathError);
    await expect(backend.delete('../x')).rejects.toThrow(WorkspacePathError);
  });
});

// ---------------------------------------------------------------------------
// Fake S3 (in-process HTTP) with SigV4 header verification
// ---------------------------------------------------------------------------

describe('S3Backend against fake S3', () => {
  let server: HttpServer;
  let endpoint: string;
  const objects = new Map<string, Buffer>();
  const authHeaders: string[] = [];

  beforeAll(async () => {
    server = createHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const auth = req.headers.authorization ?? '';
      authHeaders.push(auth);
      if (
        !/^AWS4-HMAC-SHA256 Credential=testkey\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(auth)
      ) {
        res.writeHead(403).end('bad signature shape');
        return;
      }
      const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
      const bucket = parts[0];
      const key = parts.slice(1).join('/');
      if (bucket !== 'ws-bucket') {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const body =
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
          `<IsTruncated>false</IsTruncated>` +
          keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('') +
          `</ListBucketResult>`;
        res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        if (req.method === 'PUT') {
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200).end();
        } else if (req.method === 'GET') {
          const data = objects.get(key);
          if (!data) res.writeHead(404).end();
          else res.writeHead(200).end(data);
        } else if (req.method === 'HEAD') {
          const data = objects.get(key);
          if (!data) res.writeHead(404).end();
          else res.writeHead(200, { 'content-length': String(data.length), 'last-modified': new Date(0).toUTCString() }).end();
        } else if (req.method === 'DELETE') {
          objects.delete(key);
          res.writeHead(204).end();
        } else {
          res.writeHead(405).end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('round-trips objects with signed requests', async () => {
    const s3 = new S3Backend({ endpoint, bucket: 'ws-bucket', accessKey: 'testkey', secretKey: 'testsecret' });
    await s3.write('docs/one.txt', 's3 hello');
    await s3.write('docs/two.txt', 's3 world');
    expect((await s3.read('docs/one.txt')).toString()).toBe('s3 hello');
    expect(await s3.list('docs')).toEqual(['docs/one.txt', 'docs/two.txt']);
    expect((await s3.stat('docs/two.txt'))?.size).toBe(8);
    expect(await s3.stat('missing.txt')).toBeNull();
    await s3.delete('docs/one.txt');
    expect(await s3.list('')).toEqual(['docs/two.txt']);
    await expect(s3.read('docs/one.txt')).rejects.toThrow(/not found/);
    expect(authHeaders.length).toBeGreaterThan(0);
    expect(authHeaders.every((h) => h.startsWith('AWS4-HMAC-SHA256'))).toBe(true);
  });

  it('rejects traversal', async () => {
    const s3 = new S3Backend({ endpoint, bucket: 'ws-bucket', accessKey: 'k', secretKey: 's' });
    await expect(s3.write('../evil', 'x')).rejects.toThrow(WorkspacePathError);
  });
});

// ---------------------------------------------------------------------------
// Fake PostgreSQL wire server
// ---------------------------------------------------------------------------

function pgSend(socket: Socket, type: string, payload: Buffer): void {
  const len = Buffer.alloc(4);
  len.writeInt32BE(payload.length + 4, 0);
  socket.write(Buffer.concat([Buffer.from(type, 'ascii'), len, payload]));
}
function pgInt32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}
function pgAuthOk(socket: Socket): void {
  pgSend(socket, 'R', pgInt32(0));
  pgSend(socket, 'S', Buffer.concat([Buffer.from('server_version\0', 'utf8'), Buffer.from('16.0\0', 'utf8')]));
  pgSend(socket, 'K', Buffer.concat([pgInt32(123), pgInt32(456)]));
  pgSend(socket, 'Z', Buffer.from('I'));
}
function pgRowDescription(socket: Socket, columns: string[]): void {
  const parts: Buffer[] = [];
  const n = Buffer.alloc(2);
  n.writeInt16BE(columns.length, 0);
  parts.push(n);
  for (const col of columns) {
    const tail = Buffer.alloc(18);
    tail.writeInt32BE(25, 8); // typeOID text at offset: 4(table)+2(attnum)=6... layout below
    // Field layout after name\0: tableOID(4) colAttnum(2) typeOID(4) typeLen(2) typeMod(4) format(2)
    tail.writeInt32BE(0, 0);
    tail.writeInt16BE(0, 4);
    tail.writeInt32BE(25, 6);
    tail.writeInt16BE(-1, 10);
    tail.writeInt32BE(-1, 12);
    tail.writeInt16BE(0, 16);
    parts.push(Buffer.from(`${col}\0`, 'utf8'), tail);
  }
  pgSend(socket, 'T', Buffer.concat(parts));
}
function pgDataRow(socket: Socket, values: Array<string | null>): void {
  const n = Buffer.alloc(2);
  n.writeInt16BE(values.length, 0);
  const parts: Buffer[] = [n];
  for (const v of values) {
    if (v === null) parts.push(pgInt32(-1));
    else {
      const b = Buffer.from(v, 'utf8');
      parts.push(pgInt32(b.length), b);
    }
  }
  pgSend(socket, 'D', Buffer.concat(parts));
}
function pgComplete(socket: Socket, tag: string): void {
  pgSend(socket, 'C', Buffer.from(`${tag}\0`, 'utf8'));
  pgSend(socket, 'Z', Buffer.from('I'));
}

type PgAuthMode = 'ok' | 'cleartext' | 'md5' | 'scram';

function startFakePg(authMode: PgAuthMode, store: Map<string, Buffer>): Promise<{ server: NetServer; port: number }> {
  const server = createNetServer((socket) => {
    let buf = Buffer.alloc(0);
    let started = false;
    let authed = authMode === 'ok';
    const salt = Buffer.from([1, 2, 3, 4]);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 4) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          buf = buf.subarray(len);
          started = true;
          if (authMode === 'ok') {
            authed = true;
            pgAuthOk(socket);
          } else if (authMode === 'cleartext') {
            pgSend(socket, 'R', pgInt32(3));
          } else if (authMode === 'md5') {
            pgSend(socket, 'R', Buffer.concat([pgInt32(5), salt]));
          } else {
            pgSend(socket, 'R', Buffer.concat([pgInt32(10), Buffer.from('SCRAM-SHA-256\0\0', 'utf8')]));
          }
          continue;
        }
        if (buf.length < 5) return;
        const type = String.fromCharCode(buf[0]);
        const len = buf.readInt32BE(1);
        if (buf.length < 1 + len) return;
        const payload = buf.subarray(5, 1 + len);
        buf = buf.subarray(1 + len);
        if (type === 'X') {
          socket.end();
          return;
        }
        if (type === 'p') {
          const pw = payload.subarray(0, payload.indexOf(0)).toString('utf8');
          if (authMode === 'cleartext' && pw !== 'pw123') {
            socket.destroy();
            return;
          }
          if (authMode === 'md5') {
            const inner = createHash('md5').update('pw123pguser').digest('hex');
            const expected = 'md5' + createHash('md5').update(Buffer.concat([Buffer.from(inner, 'ascii'), salt])).digest('hex');
            if (pw !== expected) {
              socket.destroy();
              return;
            }
          }
          authed = true;
          pgAuthOk(socket);
          continue;
        }
        if (type === 'Q' && authed) {
          const sql = payload.subarray(0, payload.indexOf(0)).toString('utf8');
          handleSql(socket, sql, store);
          continue;
        }
        return;
      }
    });
  });
  return new Promise((resolveFn) => {
    server.listen(0, '127.0.0.1', () => resolveFn({ server, port: (server.address() as AddressInfo).port }));
  });
}

function unquote(s: string): string {
  return s.replace(/''/g, "'");
}

function handleSql(socket: Socket, sql: string, store: Map<string, Buffer>): void {
  if (sql.startsWith('CREATE TABLE')) {
    pgComplete(socket, 'CREATE TABLE');
    return;
  }
  const insert = sql.match(/VALUES \('((?:[^']|'')*)', '\\x([0-9a-f]*)'::bytea\)/);
  if (insert) {
    store.set(unquote(insert[1]), Buffer.from(insert[2], 'hex'));
    pgComplete(socket, 'INSERT 0 1');
    return;
  }
  const selectData = sql.match(/SELECT data FROM \S+ WHERE path = '((?:[^']|'')*)'/);
  if (selectData) {
    const data = store.get(unquote(selectData[1]));
    pgRowDescription(socket, ['data']);
    if (data) pgDataRow(socket, [`\\x${data.toString('hex')}`]);
    pgComplete(socket, `SELECT ${data ? 1 : 0}`);
    return;
  }
  const selectStat = sql.match(/SELECT octet_length\(data\) AS size.*WHERE path = '((?:[^']|'')*)'/s);
  if (selectStat) {
    const data = store.get(unquote(selectStat[1]));
    pgRowDescription(socket, ['size', 'mtime']);
    if (data) pgDataRow(socket, [String(data.length), '1700000000000']);
    pgComplete(socket, `SELECT ${data ? 1 : 0}`);
    return;
  }
  if (sql.startsWith('SELECT path FROM')) {
    pgRowDescription(socket, ['path']);
    const paths = [...store.keys()].sort();
    for (const p of paths) pgDataRow(socket, [p]);
    pgComplete(socket, `SELECT ${paths.length}`);
    return;
  }
  const del = sql.match(/DELETE FROM \S+ WHERE path = '((?:[^']|'')*)'/);
  if (del) {
    store.delete(unquote(del[1]));
    pgComplete(socket, 'DELETE 1');
    return;
  }
  if (sql === 'SELECT 1') {
    pgRowDescription(socket, ['?column?']);
    pgDataRow(socket, ['1']);
    pgComplete(socket, 'SELECT 1');
    return;
  }
  pgSend(socket, 'E', Buffer.from('SERROR\0CXX000\0Mfake pg: unhandled sql\0\0', 'utf8'));
  pgSend(socket, 'Z', Buffer.from('I'));
}

describe('PostgresBackend against fake PG wire server', () => {
  const servers: NetServer[] = [];
  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop()!;
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('round-trips with md5 auth', async () => {
    const store = new Map<string, Buffer>();
    const { server, port } = await startFakePg('md5', store);
    servers.push(server);
    const pg = new PostgresBackend({ host: '127.0.0.1', port, user: 'pguser', password: 'pw123', database: 'ws' });
    await pg.write('a/b.txt', 'pg hello');
    expect((await pg.read('a/b.txt')).toString()).toBe('pg hello');
    expect(await pg.list('')).toEqual(['a/b.txt']);
    expect((await pg.stat('a/b.txt'))?.size).toBe(8);
    await pg.delete('a/b.txt');
    await expect(pg.read('a/b.txt')).rejects.toThrow(/not found/);
    expect((await pg.health()).ok).toBe(true);
  });

  it('round-trips with cleartext auth', async () => {
    const store = new Map<string, Buffer>();
    const { server, port } = await startFakePg('cleartext', store);
    servers.push(server);
    const pg = new PostgresBackend({ host: '127.0.0.1', port, user: 'pguser', password: 'pw123', database: 'ws' });
    await pg.write('x.txt', 'clear');
    expect((await pg.read('x.txt')).toString()).toBe('clear');
  });

  it('fails cleanly on SCRAM (unsupported)', async () => {
    const store = new Map<string, Buffer>();
    const { server, port } = await startFakePg('scram', store);
    servers.push(server);
    const pg = new PostgresBackend({ host: '127.0.0.1', port, user: 'pguser', password: 'pw123', database: 'ws' });
    await expect(pg.write('x.txt', 'nope')).rejects.toThrow(/SCRAM.*not supported/);
  });
});

// ---------------------------------------------------------------------------
// Composite + registry
// ---------------------------------------------------------------------------

describe('CompositeBackend', () => {
  it('reads fall through, write modes behave, lists union', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-comp-'));
    try {
      const a = new LocalBackend(join(dir, 'a'));
      const b = new LocalBackend(join(dir, 'b'));
      await b.write('only-b.txt', 'from b');
      const primary = new CompositeBackend([a, b]);
      expect((await primary.read('only-b.txt')).toString()).toBe('from b'); // fallthrough
      await primary.write('only-a.txt', 'from a');
      expect(await a.list('')).toContain('only-a.txt');
      expect(await b.list('')).not.toContain('only-a.txt');

      const all = new CompositeBackend([a, b], { writeMode: 'all' });
      await all.write('both.txt', 'everywhere');
      expect(await a.list('')).toContain('both.txt');
      expect(await b.list('')).toContain('both.txt');
      expect(await all.list('')).toEqual(expect.arrayContaining(['only-a.txt', 'only-b.txt', 'both.txt']));
      await all.delete('both.txt');
      expect(await all.stat('both.txt')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('registry parsing', () => {
  it('parses named backends + assignments and resolves per bot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-reg-'));
    try {
      const parsed = parseWorkspaceBackendsConfig({
        backends: {
          fast: { type: 'local', root: join(dir, 'fast') },
          cold: { type: 's3', endpoint: 'http://localhost:9000', bucket: 'b', accessKey: 'k', secretKey: 's' },
          both: { type: 'composite', backends: ['fast', 'cold'], writeMode: 'all' },
        },
        assignments: { 'bot-1': 'both' },
        defaultBackend: 'fast',
      });
      expect(parsed.backends.get('fast')?.kind).toBe('local');
      expect(parsed.backends.get('cold')?.kind).toBe('s3');
      expect(parsed.backends.get('both')?.kind).toBe('composite');
      expect(resolveBackendForBot(parsed, 'bot-1')?.name).toBe('both');
      expect(resolveBackendForBot(parsed, 'other')?.name).toBe('fast');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads from WORKSPACE_BACKENDS_JSON and rejects bad config', async () => {
    const parsed = await loadWorkspaceBackendsFromEnv({
      WORKSPACE_BACKENDS_JSON: JSON.stringify({ backends: { main: { type: 'local', root: '/tmp/x' } } }),
    } as NodeJS.ProcessEnv);
    expect(parsed?.backends.get('main')?.kind).toBe('local');
    expect(await loadWorkspaceBackendsFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(() => parseWorkspaceBackendsConfig({ backends: { bad: { type: 's3', endpoint: 'http://x' } } })).toThrow(/missing required field/);
    expect(() => parseWorkspaceBackendsConfig({ backends: { bad: { type: 'nope' as never } } })).toThrow(/unknown type/);
  });
});
