// SPDX-License-Identifier: Apache-2.0
// Pluggable workspace backends: local disk, S3-compatible object storage,
// PostgreSQL bytea storage, and composites — behind one Buffer-based,
// path-normalized, traversal-safe interface.
//
// All protocol code here is original, written from public specifications:
//  - S3: REST + AWS Signature Version 4 (AWS docs, public signing algorithm).
//  - PostgreSQL: the frontend/backend protocol v3 (PostgreSQL docs, public):
//    startup, cleartext + md5 password auth, simple query. SCRAM-SHA-256
//    (auth type 10) is explicitly UNSUPPORTED and fails with a clear error.
//
// This module is intentionally NOT re-exported from the package index
// (host imports it via `@mvp/agent-runtime/dist/workspace-backends.js`,
// following the worktrees/hooks subpath precedent in apps/api/src/index.ts).

import { createHash, createHmac } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { promises as fsp } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Common interface + path safety
// ---------------------------------------------------------------------------

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

/**
 * Normalize a workspace-relative path. Rejects absolute paths, backslashes,
 * NUL, empty segments are collapsed, and any `..` that would escape the
 * root. Returns a forward-slash relative path ('' = the root itself).
 */
export function normalizeWorkspacePath(input: string): string {
  if (typeof input !== 'string') throw new WorkspacePathError('path must be a string');
  if (input.includes('\0')) throw new WorkspacePathError('path must not contain NUL');
  if (input.includes('\\')) throw new WorkspacePathError('path must use forward slashes');
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
    throw new WorkspacePathError('absolute paths are not allowed in a workspace backend');
  }
  const out: string[] = [];
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) throw new WorkspacePathError(`path escapes the workspace: ${input}`);
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

export interface WorkspaceStat {
  path: string;
  size: number;
  mtimeMs?: number;
  exists: boolean;
  isDirectory?: boolean;
}

export interface WorkspaceBackend {
  readonly kind: string;
  /** Display/registry name, set by the registry when parsed from config. */
  name?: string;
  read(path: string): Promise<Buffer>;
  write(path: string, data: Buffer | string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  delete(path: string): Promise<void>;
  stat(path: string): Promise<WorkspaceStat | null>;
  /** Cheap liveness probe used by storage-admin health checks. */
  health?(): Promise<{ ok: boolean; detail?: string }>;
}

function toBuffer(data: Buffer | string): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

// ---------------------------------------------------------------------------
// LocalBackend — parity with today's on-disk workspaces
// ---------------------------------------------------------------------------

export class LocalBackend implements WorkspaceBackend {
  readonly kind = 'local';
  name?: string;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  get rootDir(): string {
    return this.root;
  }

  private abs(rel: string): string {
    const abs = resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new WorkspacePathError(`path escapes the workspace: ${rel}`);
    }
    return abs;
  }

  async read(path: string): Promise<Buffer> {
    return fsp.readFile(this.abs(normalizeWorkspacePath(path)));
  }

  async write(path: string, data: Buffer | string): Promise<void> {
    const abs = this.abs(normalizeWorkspacePath(path));
    await fsp.mkdir(dirname(abs), { recursive: true });
    await fsp.writeFile(abs, toBuffer(data));
  }

  async list(prefix = ''): Promise<string[]> {
    const relPrefix = normalizeWorkspacePath(prefix);
    const start = this.abs(relPrefix);
    const out: string[] = [];
    const walk = async (dir: string, relBase: string): Promise<void> => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), rel);
        else if (e.isFile()) out.push(rel);
      }
    };
    // list('') walks the root; list('dir') walks that subtree and returns
    // paths relative to the root (prefix included).
    await walk(start, relPrefix);
    return out.sort();
  }

  async delete(path: string): Promise<void> {
    await fsp.rm(this.abs(normalizeWorkspacePath(path)), { force: true });
  }

  async stat(path: string): Promise<WorkspaceStat | null> {
    const rel = normalizeWorkspacePath(path);
    try {
      const st = await fsp.stat(this.abs(rel));
      return { path: rel, size: st.size, mtimeMs: st.mtimeMs, exists: true, isDirectory: st.isDirectory() };
    } catch {
      return null;
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await fsp.mkdir(this.root, { recursive: true });
      return { ok: true, detail: this.root };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// S3Backend — S3 REST with AWS SigV4 signing (original implementation)
// ---------------------------------------------------------------------------

export interface S3BackendOptions {
  endpoint: string; // e.g. https://s3.amazonaws.com or http://localhost:9000 (MinIO)
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string; // default us-east-1
  /** Path-style addressing (<endpoint>/<bucket>/<key>). Default true (MinIO/localstack friendly). */
  pathStyle?: boolean;
  /** Optional key prefix inside the bucket. */
  prefix?: string;
  fetchFn?: typeof fetch;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}
/** AWS SigV4 signing-key derivation (public algorithm). */
export function deriveSigningKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function encodeKey(key: string): string {
  return key.split('/').map((s) => encodeURIComponent(s)).join('/');
}
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export class S3Backend implements WorkspaceBackend {
  readonly kind = 's3';
  name?: string;
  private readonly opts: Required<Omit<S3BackendOptions, 'fetchFn' | 'prefix'>> & {
    fetchFn: typeof fetch;
    prefix: string;
  };

  constructor(opts: S3BackendOptions) {
    this.opts = {
      endpoint: opts.endpoint.replace(/\/+$/, ''),
      bucket: opts.bucket,
      accessKey: opts.accessKey,
      secretKey: opts.secretKey,
      region: opts.region ?? 'us-east-1',
      pathStyle: opts.pathStyle ?? true,
      prefix: opts.prefix ? normalizeWorkspacePath(opts.prefix) : '',
      fetchFn: opts.fetchFn ?? fetch,
    };
  }

  private objectUrl(key: string, query?: Record<string, string>): { url: string; host: string; canonicalUri: string; canonicalQuery: string } {
    const fullKey = this.opts.prefix ? `${this.opts.prefix}/${key}` : key;
    const encoded = encodeKey(fullKey);
    const ep = new URL(this.opts.endpoint);
    let pathPart: string;
    let host = ep.host;
    if (this.opts.pathStyle) {
      pathPart = `/${this.opts.bucket}/${encoded}`;
    } else {
      host = `${this.opts.bucket}.${ep.host}`;
      pathPart = `/${encoded}`;
    }
    const qs = query
      ? Object.entries(query)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&')
      : '';
    const base = `${ep.protocol}//${host}${ep.port && !host.includes(':') ? '' : ''}${pathPart}`;
    // Rebuild honoring non-default endpoint port for virtual-host style.
    const urlObj = new URL(base);
    if (!this.opts.pathStyle) urlObj.port = ep.port;
    else urlObj.port = ep.port;
    return { url: qs ? `${urlObj.toString()}?${qs}` : urlObj.toString(), host: urlObj.host, canonicalUri: pathPart, canonicalQuery: qs };
  }

  /** Sign and issue one S3 request. Returns the raw Response. */
  private async request(
    method: string,
    key: string,
    opts: { query?: Record<string, string>; body?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const { url, host, canonicalUri, canonicalQuery } = this.objectUrl(key, opts.query);
    const body = opts.body ?? Buffer.alloc(0);
    const payloadHash = sha256Hex(body);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...(opts.headers ?? {}),
    };
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}:${headers[k].trim()}\n`)
      .join('');
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${this.opts.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac('sha256', deriveSigningKey(this.opts.secretKey, dateStamp, this.opts.region, 's3'))
      .update(stringToSign, 'utf8')
      .digest('hex');
    headers['Authorization'] =
      `AWS4-HMAC-SHA256 Credential=${this.opts.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const res = await this.opts.fetchFn(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });
    return res;
  }

  async read(path: string): Promise<Buffer> {
    const key = normalizeWorkspacePath(path);
    const res = await this.request('GET', key);
    if (res.status === 404) throw new Error(`s3 object not found: ${path}`);
    if (!res.ok) throw new Error(`s3 GET failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async write(path: string, data: Buffer | string): Promise<void> {
    const key = normalizeWorkspacePath(path);
    const res = await this.request('PUT', key, { body: toBuffer(data) });
    if (!res.ok) throw new Error(`s3 PUT failed: ${res.status}`);
  }

  async list(prefix = ''): Promise<string[]> {
    const relPrefix = normalizeWorkspacePath(prefix);
    const fullPrefix = this.opts.prefix
      ? relPrefix
        ? `${this.opts.prefix}/${relPrefix}`
        : this.opts.prefix
      : relPrefix;
    const keys: string[] = [];
    let continuation: string | undefined;
    for (;;) {
      const query: Record<string, string> = { 'list-type': '2' };
      if (fullPrefix) query['prefix'] = fullPrefix;
      if (continuation) query['continuation-token'] = continuation;
      // ListObjectsV2 is a bucket-level request: empty key, query carries it.
      const res = await this.request('GET', '', { query });
      if (!res.ok) throw new Error(`s3 LIST failed: ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
        let k = decodeXmlEntities(m[1]);
        if (this.opts.prefix && k.startsWith(`${this.opts.prefix}/`)) k = k.slice(this.opts.prefix.length + 1);
        keys.push(k);
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
      if (!truncated || !token) break;
      continuation = decodeXmlEntities(token);
    }
    return keys.sort();
  }

  async delete(path: string): Promise<void> {
    const key = normalizeWorkspacePath(path);
    const res = await this.request('DELETE', key);
    if (!res.ok && res.status !== 404) throw new Error(`s3 DELETE failed: ${res.status}`);
  }

  async stat(path: string): Promise<WorkspaceStat | null> {
    const rel = normalizeWorkspacePath(path);
    const res = await this.request('HEAD', rel);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3 HEAD failed: ${res.status}`);
    const size = Number(res.headers.get('content-length') ?? 0);
    const lm = res.headers.get('last-modified');
    return { path: rel, size: Number.isFinite(size) ? size : 0, mtimeMs: lm ? Date.parse(lm) : undefined, exists: true };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.list('');
      return { ok: true, detail: `bucket ${this.opts.bucket}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// PostgresBackend — minimal PostgreSQL wire client (original, protocol v3)
// ---------------------------------------------------------------------------

export interface PostgresBackendOptions {
  host: string;
  port?: number; // default 5432
  user: string;
  password?: string;
  database: string;
  /** Table holding (path text PRIMARY KEY, data bytea, updated_at). Default workspace_files. */
  table?: string;
  /** Test hook: replace the socket factory. */
  connectFn?: (host: string, port: number) => Promise<Socket>;
}

function pgInt32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}
function pgMsg(type: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type, 'ascii'), pgInt32(payload.length + 4), payload]);
}
function pgCString(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}
/** Escape a string literal (standard_conforming_strings = on assumed). */
function pgLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
function md5Hex(data: string | Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

interface PgRow {
  [column: string]: string | null;
}

/**
 * One-shot-per-operation connection speaking just enough of the wire
 * protocol: startup → auth (ok / cleartext / md5; SCRAM rejected) →
 * simple query → terminate. A fresh connection per operation keeps the
 * state machine trivially correct; workspace traffic is not hot-path.
 */
class PgSimpleClient {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private waiters: Array<{ resolve: (msgs: Array<{ type: string; payload: Buffer }>) => void; reject: (e: Error) => void }> = [];
  private pending: Array<{ type: string; payload: Buffer }> = [];
  private collecting = false;
  private socketError: Error | null = null;

  constructor(private readonly opts: PostgresBackendOptions) {}

  private async open(): Promise<Socket> {
    if (this.opts.connectFn) return this.opts.connectFn(this.opts.host, this.opts.port ?? 5432);
    return new Promise((resolveFn, rejectFn) => {
      const sock = createConnection({ host: this.opts.host, port: this.opts.port ?? 5432 }, () => resolveFn(sock));
      sock.once('error', rejectFn);
    });
  }

  /**
   * A cycle ends at ReadyForQuery ('Z') — OR, during startup, at an
   * authentication request ('R' with a non-zero code): the server waits
   * for our password message before it will ever send ReadyForQuery, so
   * resolving only on 'Z' would deadlock the auth handshake.
   */
  private cycleEndIndex(): number {
    for (let i = 0; i < this.pending.length; i++) {
      const m = this.pending[i];
      if (m.type === 'Z') return i;
      if (m.type === 'R' && m.payload.length >= 4 && m.payload.readInt32BE(0) !== 0) return i;
      if (m.type === 'E') return i;
    }
    return -1;
  }

  private tryResolve(): void {
    if (!this.collecting || this.waiters.length === 0) return;
    const idx = this.cycleEndIndex();
    if (idx < 0) return;
    const msgs = this.pending.splice(0, idx + 1);
    this.collecting = false;
    this.waiters.shift()?.resolve(msgs);
  }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 5) return;
      const type = String.fromCharCode(this.buffer[0]);
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < 1 + len) return;
      const payload = this.buffer.subarray(5, 1 + len);
      this.buffer = this.buffer.subarray(1 + len);
      this.pending.push({ type, payload: Buffer.from(payload) });
      this.tryResolve();
    }
  }

  /** Wait for the current cycle to end, returning its messages. */
  private waitReady(): Promise<Array<{ type: string; payload: Buffer }>> {
    if (this.socketError) return Promise.reject(this.socketError);
    this.collecting = true;
    return new Promise((resolveFn, rejectFn) => {
      this.waiters.push({ resolve: resolveFn, reject: rejectFn });
      // Messages may already be fully buffered (startup is sequential).
      this.tryResolve();
      void rejectFn; // rejection flows through the socket error handler
    });
  }

  async connect(): Promise<void> {
    const sock = await this.open();
    this.socket = sock;
    sock.on('data', (c) => this.feed(c));
    sock.on('error', (err) => {
      this.socketError = err;
      this.waiters.splice(0).forEach((w) => w.reject(err));
    });
    const startup = Buffer.concat([
      pgInt32(196608), // protocol 3.0
      pgCString('user'), pgCString(this.opts.user),
      pgCString('database'), pgCString(this.opts.database),
      Buffer.from([0]),
    ]);
    sock.write(Buffer.concat([pgInt32(startup.length + 4), startup]));
    // Auth loop: may need a password round-trip before ReadyForQuery.
    for (;;) {
      const msgs = await this.waitReady();
      let needPassword: { kind: 'cleartext' } | { kind: 'md5'; salt: Buffer } | null = null;
      let ready = false;
      for (const m of msgs) {
        if (m.type === 'R') {
          const code = m.payload.readInt32BE(0);
          if (code === 0) continue; // AuthenticationOk — ReadyForQuery follows in this batch or the next
          if (code === 3) needPassword = { kind: 'cleartext' };
          else if (code === 5) needPassword = { kind: 'md5', salt: Buffer.from(m.payload.subarray(4, 8)) };
          else if (code === 10) {
            throw new Error('postgres SCRAM authentication (SASL) is not supported by PostgresBackend — use cleartext/md5 auth or a local trust setup');
          } else {
            throw new Error(`postgres authentication method ${code} is not supported by PostgresBackend`);
          }
        }
        if (m.type === 'E') throw pgError(m.payload);
        if (m.type === 'Z') ready = true;
      }
      if (needPassword) {
        if (this.opts.password === undefined) throw new Error('postgres server requires a password but none was configured');
        let pw: string;
        if (needPassword.kind === 'cleartext') {
          pw = this.opts.password;
        } else {
          const inner = md5Hex(`${this.opts.password}${this.opts.user}`);
          pw = 'md5' + md5Hex(Buffer.concat([Buffer.from(inner, 'ascii'), needPassword.salt]));
        }
        sock.write(pgMsg('p', pgCString(pw)));
        continue;
      }
      if (ready) return;
    }
  }

  async query(sql: string): Promise<PgRow[]> {
    if (!this.socket) throw new Error('postgres client is not connected');
    this.socket.write(pgMsg('Q', pgCString(sql)));
    const msgs = await this.waitReady();
    const columns: string[] = [];
    const rows: PgRow[] = [];
    for (const m of msgs) {
      if (m.type === 'T') {
        const n = m.payload.readInt16BE(0);
        let off = 2;
        for (let i = 0; i < n; i++) {
          const end = m.payload.indexOf(0, off);
          columns.push(m.payload.subarray(off, end).toString('utf8'));
          off = end + 1 + 18; // name\0 + tableOID(4)+colAttnum(2)+typeOID(4)+typeLen(2)+typeMod(4)+format(2)
        }
      } else if (m.type === 'D') {
        const n = m.payload.readInt16BE(0);
        let off = 2;
        const row: PgRow = {};
        for (let i = 0; i < n; i++) {
          const len = m.payload.readInt32BE(off);
          off += 4;
          if (len < 0) {
            row[columns[i]] = null;
          } else {
            row[columns[i]] = m.payload.subarray(off, off + len).toString('utf8');
            off += len;
          }
        }
        rows.push(row);
      } else if (m.type === 'E') {
        throw pgError(m.payload);
      }
    }
    return rows;
  }

  async close(): Promise<void> {
    try {
      this.socket?.write(pgMsg('X', Buffer.alloc(0)));
    } catch { /* ignore */ }
    this.socket?.end();
    this.socket = null;
  }
}

function pgError(payload: Buffer): Error {
  const fields: Record<string, string> = {};
  let off = 0;
  while (off < payload.length && payload[off] !== 0) {
    const code = String.fromCharCode(payload[off]);
    const end = payload.indexOf(0, off + 1);
    fields[code] = payload.subarray(off + 1, end).toString('utf8');
    off = end + 1;
  }
  return new Error(`postgres error ${fields['C'] ?? ''}: ${fields['M'] ?? 'unknown error'}`);
}

export class PostgresBackend implements WorkspaceBackend {
  readonly kind = 'postgres';
  name?: string;
  private readonly table: string;
  private tableReady = false;

  constructor(private readonly opts: PostgresBackendOptions) {
    const table = opts.table ?? 'workspace_files';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`invalid postgres table name: ${table}`);
    this.table = table;
  }

  private async withClient<T>(fn: (c: PgSimpleClient) => Promise<T>): Promise<T> {
    const client = new PgSimpleClient(this.opts);
    try {
      await client.connect();
      if (!this.tableReady) {
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${this.table} (path text PRIMARY KEY, data bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
        );
        this.tableReady = true;
      }
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  async read(path: string): Promise<Buffer> {
    const rel = normalizeWorkspacePath(path);
    return this.withClient(async (c) => {
      const rows = await c.query(`SELECT data FROM ${this.table} WHERE path = ${pgLiteral(rel)}`);
      if (rows.length === 0 || rows[0].data === null) throw new Error(`postgres object not found: ${path}`);
      const raw = rows[0].data;
      if (raw.startsWith('\\x')) return Buffer.from(raw.slice(2), 'hex');
      return Buffer.from(raw, 'utf8');
    });
  }

  async write(path: string, data: Buffer | string): Promise<void> {
    const rel = normalizeWorkspacePath(path);
    const hex = toBuffer(data).toString('hex');
    await this.withClient(async (c) => {
      await c.query(
        `INSERT INTO ${this.table} (path, data) VALUES (${pgLiteral(rel)}, '\\x${hex}'::bytea) ` +
          `ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      );
    });
  }

  async list(prefix = ''): Promise<string[]> {
    const rel = normalizeWorkspacePath(prefix);
    return this.withClient(async (c) => {
      const rows = rel
        ? await c.query(`SELECT path FROM ${this.table} WHERE path LIKE ${pgLiteral(`${rel.replace(/[%_]/g, '')}%`)} ORDER BY path`)
        : await c.query(`SELECT path FROM ${this.table} ORDER BY path`);
      return rows.map((r) => r.path as string).filter((p) => !rel || p === rel || p.startsWith(`${rel}/`));
    });
  }

  async delete(path: string): Promise<void> {
    const rel = normalizeWorkspacePath(path);
    await this.withClient(async (c) => {
      await c.query(`DELETE FROM ${this.table} WHERE path = ${pgLiteral(rel)}`);
    });
  }

  async stat(path: string): Promise<WorkspaceStat | null> {
    const rel = normalizeWorkspacePath(path);
    return this.withClient(async (c) => {
      const rows = await c.query(
        `SELECT octet_length(data) AS size, extract(epoch from updated_at) * 1000 AS mtime FROM ${this.table} WHERE path = ${pgLiteral(rel)}`,
      );
      if (rows.length === 0) return null;
      return { path: rel, size: Number(rows[0].size ?? 0), mtimeMs: Number(rows[0].mtime ?? 0) || undefined, exists: true };
    });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      return await this.withClient(async (c) => {
        await c.query('SELECT 1');
        return { ok: true, detail: `table ${this.table}` };
      });
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// CompositeBackend — read fallthrough, write primary-or-all
// ---------------------------------------------------------------------------

export interface CompositeBackendOptions {
  /** 'primary' writes only to backends[0]; 'all' writes to every backend. */
  writeMode?: 'primary' | 'all';
}

export class CompositeBackend implements WorkspaceBackend {
  readonly kind = 'composite';
  name?: string;

  constructor(
    private readonly backends: WorkspaceBackend[],
    private readonly opts: CompositeBackendOptions = {},
  ) {
    if (backends.length === 0) throw new Error('CompositeBackend requires at least one backend');
  }

  get members(): WorkspaceBackend[] {
    return [...this.backends];
  }

  async read(path: string): Promise<Buffer> {
    let lastErr: unknown;
    for (const b of this.backends) {
      try {
        return await b.read(path);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`composite read failed: ${path}`);
  }

  async write(path: string, data: Buffer | string): Promise<void> {
    if ((this.opts.writeMode ?? 'primary') === 'primary') {
      await this.backends[0].write(path, data);
      return;
    }
    await Promise.all(this.backends.map((b) => b.write(path, data)));
  }

  async list(prefix = ''): Promise<string[]> {
    const seen = new Set<string>();
    for (const b of this.backends) {
      try {
        for (const p of await b.list(prefix)) seen.add(p);
      } catch { /* fall through to remaining backends */ }
    }
    return [...seen].sort();
  }

  async delete(path: string): Promise<void> {
    await Promise.allSettled(this.backends.map((b) => b.delete(path)));
  }

  async stat(path: string): Promise<WorkspaceStat | null> {
    for (const b of this.backends) {
      try {
        const st = await b.stat(path);
        if (st) return st;
      } catch { /* try next */ }
    }
    return null;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const parts: string[] = [];
    let anyOk = false;
    for (const b of this.backends) {
      const h = b.health ? await b.health() : { ok: true };
      if (h.ok) anyOk = true;
      parts.push(`${b.name ?? b.kind}:${h.ok ? 'ok' : 'down'}`);
    }
    return { ok: anyOk, detail: parts.join(', ') };
  }
}

// ---------------------------------------------------------------------------
// Named registry: config parsing + per-bot assignment
// ---------------------------------------------------------------------------

export interface WorkspaceBackendConfigEntry {
  type: 'local' | 's3' | 'postgres' | 'composite';
  // local
  root?: string;
  // s3
  endpoint?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
  region?: string;
  pathStyle?: boolean;
  prefix?: string;
  // postgres
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  table?: string;
  // composite
  backends?: string[];
  writeMode?: 'primary' | 'all';
}

export interface WorkspaceBackendsConfig {
  backends: Record<string, WorkspaceBackendConfigEntry>;
  /** botId → backend name. */
  assignments?: Record<string, string>;
  defaultBackend?: string;
}

export interface ParsedWorkspaceBackends {
  backends: Map<string, WorkspaceBackend>;
  assignments: Record<string, string>;
  defaultBackend?: string;
}

function requireField(entry: WorkspaceBackendConfigEntry, field: string, backendName: string): string {
  const v = entry[field as keyof WorkspaceBackendConfigEntry];
  if (typeof v !== 'string' || !v) throw new Error(`workspace backend "${backendName}": missing required field "${field}"`);
  return v;
}

export function parseWorkspaceBackendsConfig(input: string | WorkspaceBackendsConfig): ParsedWorkspaceBackends {
  const config = (typeof input === 'string' ? JSON.parse(input) : input) as WorkspaceBackendsConfig;
  if (!config || typeof config !== 'object' || !config.backends || typeof config.backends !== 'object') {
    throw new Error('workspace backends config must be an object with a "backends" map');
  }
  const backends = new Map<string, WorkspaceBackend>();
  const pendingComposite: Array<[string, WorkspaceBackendConfigEntry]> = [];
  const buildOne = (name: string, entry: WorkspaceBackendConfigEntry): WorkspaceBackend => {
    let backend: WorkspaceBackend;
    switch (entry.type) {
      case 'local':
        backend = new LocalBackend(requireField(entry, 'root', name));
        break;
      case 's3':
        backend = new S3Backend({
          endpoint: requireField(entry, 'endpoint', name),
          bucket: requireField(entry, 'bucket', name),
          accessKey: requireField(entry, 'accessKey', name),
          secretKey: requireField(entry, 'secretKey', name),
          region: entry.region,
          pathStyle: entry.pathStyle,
          prefix: entry.prefix,
        });
        break;
      case 'postgres':
        backend = new PostgresBackend({
          host: requireField(entry, 'host', name),
          port: entry.port,
          user: requireField(entry, 'user', name),
          password: entry.password,
          database: requireField(entry, 'database', name),
          table: entry.table,
        });
        break;
      case 'composite': {
        const members = (entry.backends ?? []).map((ref) => {
          const member = backends.get(ref);
          if (!member) throw new Error(`workspace backend "${name}": composite references unknown backend "${ref}"`);
          return member;
        });
        backend = new CompositeBackend(members, { writeMode: entry.writeMode });
        break;
      }
      default:
        throw new Error(`workspace backend "${name}": unknown type "${(entry as { type?: string }).type}"`);
    }
    backend.name = name;
    return backend;
  };
  for (const [name, entry] of Object.entries(config.backends)) {
    if (entry.type === 'composite') pendingComposite.push([name, entry]);
    else backends.set(name, buildOne(name, entry));
  }
  for (const [name, entry] of pendingComposite) backends.set(name, buildOne(name, entry));
  return {
    backends,
    assignments: config.assignments ?? {},
    defaultBackend: config.defaultBackend,
  };
}

/**
 * Load the registry from the environment:
 *  - WORKSPACE_BACKENDS_JSON: inline JSON config.
 *  - WORKSPACE_BACKENDS_FILE: path to a JSON file with the same shape.
 * Returns null when neither is set.
 */
export async function loadWorkspaceBackendsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ParsedWorkspaceBackends | null> {
  const inline = (env.WORKSPACE_BACKENDS_JSON ?? '').trim();
  if (inline) return parseWorkspaceBackendsConfig(inline);
  const file = (env.WORKSPACE_BACKENDS_FILE ?? '').trim();
  if (file) {
    const raw = await fsp.readFile(file, 'utf8');
    return parseWorkspaceBackendsConfig(raw);
  }
  return null;
}

/** Resolve the backend assigned to a bot (assignment → default → first). */
export function resolveBackendForBot(
  parsed: ParsedWorkspaceBackends,
  botId: string,
): WorkspaceBackend | undefined {
  const assigned = parsed.assignments[botId];
  if (assigned && parsed.backends.has(assigned)) return parsed.backends.get(assigned);
  if (parsed.defaultBackend && parsed.backends.has(parsed.defaultBackend)) {
    return parsed.backends.get(parsed.defaultBackend);
  }
  return parsed.backends.values().next().value as WorkspaceBackend | undefined;
}
