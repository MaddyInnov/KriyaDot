// SPDX-License-Identifier: Apache-2.0
// Unit tests for the Octomind-parity closure modules: markdown renderer
// (#31), JSON-Schema validator + --schema parsing (#108), dotted -c
// overrides (#110), multi-file config + migrations + validation (#115 /
// #111), log levels (#181), terminal elicitation (#51) and the daemon
// registry / inbox / loop (#102 / #109).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderMarkdown, looksLikeMarkdown } from '../src/markdown.js';
import {
  buildRepairMessage,
  parseSchemaFlag,
  SchemaFlagError,
  validateJsonSchema,
  validateReplyAgainstSpec,
} from '../src/json-schema.js';
import { coerceOverrideValue, parseConfigOverrides, setDottedPath, UsageError } from '../src/overrides.js';
import {
  deepMerge,
  defaultConfigTemplate,
  listConfigDropIns,
  loadDropInConfig,
  migrateConfig,
  parseConfigText,
  stripJsonComments,
  validateConfigObject,
} from '../src/config-files.js';
import { loadConfigFile } from '../src/config.js';
import { createCliLogger, resolveLogLevel, shouldLog } from '../src/log.js';
import { coerceElicitationAnswer, createTerminalElicitationHandler } from '../src/elicitation.js';
import {
  drainInbox,
  enqueueInboxMessage,
  getDaemon,
  heartbeatDaemon,
  isDaemonAlive,
  loadDaemonRegistry,
  registerDaemon,
  runDaemonLoop,
  unregisterDaemon,
} from '../src/daemon.js';

describe('markdown renderer (#31)', () => {
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('renders headings, bold, code and links without markers', () => {
    const out = renderMarkdown('# Title\n\nSome **bold** and `code` and [a link](https://example.com)', { color: false });
    expect(plain(out)).toContain('Title');
    expect(plain(out)).toContain('bold');
    expect(plain(out)).toContain('a link (https://example.com)');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`code`');
  });

  it('emits ANSI styling when color is on', () => {
    const out = renderMarkdown('## Head\n\n**b**', { color: true });
    expect(out).toContain('\x1b[');
  });

  it('keeps fenced code content and closes an unterminated fence', () => {
    const out = renderMarkdown('```ts\nconst x = 1;\n```\n\nafter', { color: false });
    expect(plain(out)).toContain('const x = 1;');
    const open = renderMarkdown('```\ncode', { color: false });
    expect(plain(open)).toContain('code');
  });

  it('renders lists and quotes, and detects markdown', () => {
    const out = plain(renderMarkdown('- one\n- two\n> quoted', { color: false }));
    expect(out).toContain('• one');
    expect(out).toContain('quoted');
    expect(looksLikeMarkdown('# hi')).toBe(true);
    expect(looksLikeMarkdown('just prose.')).toBe(false);
  });
});

describe('json-schema validator (#108)', () => {
  const schema = {
    type: 'object',
    required: ['name', 'count'],
    properties: {
      name: { type: 'string', pattern: '^[a-z]+$' },
      count: { type: 'integer', minimum: 1 },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
      kind: { enum: ['a', 'b'] },
    },
    additionalProperties: false,
  } as Record<string, unknown>;

  it('accepts a valid value', () => {
    expect(validateJsonSchema({ name: 'abc', count: 2, tags: ['x'], kind: 'a' }, schema)).toEqual([]);
  });

  it('reports required, type, pattern, enum and additional-property violations', () => {
    const errs = validateJsonSchema({ name: 'ABC', count: 0, kind: 'z', extra: 1 }, schema);
    expect(errs.join('\n')).toMatch(/missing required|count/);
    expect(errs.some((e) => e.includes('pattern'))).toBe(true);
    expect(errs.some((e) => e.includes('not one of'))).toBe(true);
    expect(errs.some((e) => e.includes('additional property "extra"'))).toBe(true);
    expect(errs.some((e) => e.includes('minimum'))).toBe(true);
  });

  it('validates nested items and resolves local $refs', () => {
    const s = {
      $defs: { pos: { type: 'integer', minimum: 0 } },
      type: 'object',
      properties: { n: { $ref: '#/$defs/pos' } },
    } as Record<string, unknown>;
    expect(validateJsonSchema({ n: 3 }, s)).toEqual([]);
    expect(validateJsonSchema({ n: -1 }, s).length).toBeGreaterThan(0);
  });

  it('parseSchemaFlag handles json_object, json_schema and bare schemas', () => {
    expect(parseSchemaFlag('{"type":"json_object"}')).toEqual({ type: 'json_object' });
    expect(parseSchemaFlag('{"name":"x"}').type).toBe('json_schema');
    expect(() => parseSchemaFlag('nope')).toThrow(SchemaFlagError);
    expect(() => parseSchemaFlag('[1]')).toThrow(SchemaFlagError);
  });

  it('validateReplyAgainstSpec tolerates a json fence and builds a repair prompt', () => {
    const spec = parseSchemaFlag('{"type":"object","required":["a"],"properties":{"a":{"type":"number"}}}');
    expect(validateReplyAgainstSpec('```json\n{"a":1}\n```', spec)).toEqual([]);
    const errs = validateReplyAgainstSpec('{"a":"x"}', spec);
    expect(errs.length).toBeGreaterThan(0);
    expect(buildRepairMessage(spec, errs)).toMatch(/ONLY the corrected JSON/);
    expect(validateReplyAgainstSpec('not json', spec)[0]).toMatch(/not valid JSON/);
  });
});

describe('dotted -c overrides (#110)', () => {
  it('builds nested config with type coercion', () => {
    const ov = parseConfigOverrides(['bot.temperature=0.7', 'ui.stream=false', 'run.retries=3', 'session.name="x"'.replace(/"/g, ''), 'limits.list=[1,2]']);
    expect(ov.nested).toEqual({
      bot: { temperature: 0.7 },
      ui: { stream: false },
      run: { retries: 3 },
      session: { name: 'x' },
      limits: { list: [1, 2] },
    });
  });

  it('rejects unknown top-level roots with a helpful error', () => {
    expect(() => parseConfigOverrides(['bogus.deep=1'])).toThrow(UsageError);
    expect(() => parseConfigOverrides(['bogus.deep=1'])).toThrow(/Unknown -c key/);
    expect(() => parseConfigOverrides(['bot..x=1'])).toThrow(/empty path segment/);
  });

  it('keeps the classic flat keys working alongside dotted ones', () => {
    const ov = parseConfigOverrides(['model=m1', 'bot.temperature=0.5']);
    expect(ov.model).toBe('m1');
    expect(ov.nested).toEqual({ bot: { temperature: 0.5 } });
  });

  it('coerceOverrideValue + setDottedPath primitives', () => {
    expect(coerceOverrideValue('true')).toBe(true);
    expect(coerceOverrideValue('42')).toBe(42);
    expect(coerceOverrideValue('{"a":1}')).toEqual({ a: 1 });
    expect(coerceOverrideValue('plain')).toBe('plain');
    const target: Record<string, unknown> = {};
    setDottedPath(target, ['a', 'b', 'c'], 1);
    expect(target).toEqual({ a: { b: { c: 1 } } });
  });
});

describe('multi-file config, migrations, validation (#115/#111)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kriyadot-cfg-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stripJsonComments respects string literals (URLs survive)', () => {
    const text = '{\n// comment\n"apiUrl": "http://localhost:4000", /* block */ "token": "a//b"\n}';
    const parsed = parseConfigText(text, 'json');
    expect(parsed.apiUrl).toBe('http://localhost:4000');
    expect(parsed.token).toBe('a//b');
    expect(stripJsonComments('"http://x" // c')).toContain('http://x');
  });

  it('deepMerge: later wins, plain objects merge, arrays replace', () => {
    expect(deepMerge({ a: { x: 1, y: 2 }, arr: [1] }, { a: { y: 3 }, arr: [2] })).toEqual({ a: { x: 1, y: 3 }, arr: [2] });
  });

  it('drop-ins merge alphabetically and TOML files are listed but skipped (seam)', () => {
    writeFileSync(join(dir, '20-second.json'), JSON.stringify({ logLevel: 'warn', b: 2 }));
    writeFileSync(join(dir, '10-first.json'), JSON.stringify({ logLevel: 'debug', a: 1 }));
    writeFileSync(join(dir, '30-later.toml'), 'logLevel = "error"');
    const drops = listConfigDropIns(dir);
    expect(drops.map((d) => d.format)).toEqual(['json', 'json', 'toml']);
    expect(loadDropInConfig(dir)).toEqual({ a: 1, b: 2, logLevel: 'warn' });
    expect(() => parseConfigText('x=1', 'toml')).toThrow(/TOML/);
  });

  it('loadConfigFile merges cli.d under cli.json', () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'kriyadot-home-'));
    const saved = process.env.KRIYADOT_CONFIG_DIR;
    process.env.KRIYADOT_CONFIG_DIR = cfgDir;
    try {
      mkdirSync(join(cfgDir, 'cli.d'));
      writeFileSync(join(cfgDir, 'cli.d', '10-base.json'), JSON.stringify({ apiUrl: 'http://localhost:5050', logLevel: 'debug' }));
      writeFileSync(join(cfgDir, 'cli.json'), JSON.stringify({ token: 'tok', logLevel: 'error' }));
      const cfg = loadConfigFile();
      expect(cfg.apiUrl).toBe('http://localhost:5050');
      expect(cfg.token).toBe('tok');
      expect(cfg.logLevel).toBe('error'); // main file wins over drop-ins
    } finally {
      if (saved === undefined) delete process.env.KRIYADOT_CONFIG_DIR;
      else process.env.KRIYADOT_CONFIG_DIR = saved;
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  it('migrations walk the chain (1 → 2 no-op example stamps the version)', () => {
    expect(migrateConfig({ version: 1, apiUrl: 'http://x' })).toEqual({ version: 2, apiUrl: 'http://x' });
    expect(migrateConfig({ apiUrl: 'http://x' }).version).toBe(2);
    expect(migrateConfig({ version: 99 }).version).toBe(99); // future versions untouched
  });

  it('validateConfigObject warns on unknown keys and errors on bad types', () => {
    const v = validateConfigObject({ apiUrl: 'ftp://x', bogusKey: 1, logLevel: 'loud' });
    expect(v.valid).toBe(false);
    expect(v.warnings.join(' ')).toMatch(/unknown key "bogusKey"/);
    expect(v.errors.length).toBeGreaterThanOrEqual(2);
    expect(validateConfigObject({ apiUrl: 'http://localhost:4000', logLevel: 'info' }).valid).toBe(true);
    expect(validateConfigObject('nope').valid).toBe(false);
  });

  it('the init template parses (JSONC) and validates clean', () => {
    const parsed = parseConfigText(defaultConfigTemplate(), 'json');
    expect(validateConfigObject(parsed).valid).toBe(true);
  });
});

describe('log levels (#181)', () => {
  it('env beats config beats default; invalid values fall back', () => {
    expect(resolveLogLevel({ configLevel: 'warn', env: 'debug' })).toBe('debug');
    expect(resolveLogLevel({ configLevel: 'warn', env: undefined })).toBe('warn');
    expect(resolveLogLevel({ configLevel: 'nope', env: 'alsono' })).toBe('info');
  });

  it('the logger filters by level', () => {
    const lines: string[] = [];
    const log = createCliLogger((s) => lines.push(s), 'warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines).toEqual(['w\n', 'e\n']);
    expect(shouldLog('error', 'silent')).toBe(false);
    expect(shouldLog('debug', 'debug')).toBe(true);
  });

  it('KRIYADOT_LOG_LEVEL in the process env is honored', () => {
    const saved = process.env.KRIYADOT_LOG_LEVEL;
    process.env.KRIYADOT_LOG_LEVEL = 'error';
    try {
      expect(resolveLogLevel({ configLevel: 'debug' })).toBe('error');
    } finally {
      if (saved === undefined) delete process.env.KRIYADOT_LOG_LEVEL;
      else process.env.KRIYADOT_LOG_LEVEL = saved;
    }
  });
});

describe('terminal elicitation (#51)', () => {
  it('coerces enum-by-index, booleans and numbers', () => {
    expect(coerceElicitationAnswer('2', { enum: ['a', 'b'] })).toEqual({ ok: true, value: 'b' });
    expect(coerceElicitationAnswer('yes', { type: 'boolean' })).toEqual({ ok: true, value: true });
    expect(coerceElicitationAnswer('3.5', { type: 'number' })).toEqual({ ok: true, value: 3.5 });
    expect(coerceElicitationAnswer('3.5', { type: 'integer' }).ok).toBe(false);
    expect(coerceElicitationAnswer('maybe', { type: 'boolean' }).ok).toBe(false);
  });

  it('prompts per property and accepts with typed content', async () => {
    const answers = ['Paris', '2'];
    const logs: string[] = [];
    const handler = createTerminalElicitationHandler({
      ask: async () => answers.shift() ?? null,
      isInteractive: () => true,
      log: (m) => logs.push(m),
    });
    const res = await handler({
      message: 'Need details',
      requestedSchema: {
        type: 'object',
        required: ['city'],
        properties: { city: { type: 'string' }, size: { enum: ['s', 'l'] } },
      },
    });
    expect(res).toEqual({ action: 'accept', content: { city: 'Paris', size: 'l' } });
  });

  it('declines with a clear log line when non-interactive', async () => {
    const logs: string[] = [];
    const handler = createTerminalElicitationHandler({
      ask: async () => 'x',
      isInteractive: () => false,
      log: (m) => logs.push(m),
    });
    const res = await handler({ message: 'q?', requestedSchema: {} });
    expect(res.action).toBe('decline');
    expect(logs.join(' ')).toMatch(/non-interactive/);
  });

  it('cancels when a required answer is empty', async () => {
    const handler = createTerminalElicitationHandler({
      ask: async () => '',
      isInteractive: () => true,
      log: () => undefined,
    });
    const res = await handler({
      message: 'q',
      requestedSchema: { required: ['city'], properties: { city: { type: 'string' } } },
    });
    expect(res.action).toBe('cancel');
  });
});

describe('daemon registry + inbox + loop (#102/#109)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kriyadot-daemon-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rec = (name = 'work') => ({
    name,
    sessionId: 'sess-1',
    botId: 'coder',
    pid: 4242,
    startedAt: 1000,
    heartbeatAt: 1000,
  });

  it('registers, heartbeats, lists and unregisters', () => {
    registerDaemon(dir, rec());
    expect(getDaemon(dir, 'work')?.sessionId).toBe('sess-1');
    expect(heartbeatDaemon(dir, 'work', 5000)).toBe(true);
    expect(loadDaemonRegistry(dir).work?.heartbeatAt).toBe(5000);
    expect(heartbeatDaemon(dir, 'ghost')).toBe(false);
    expect(unregisterDaemon(dir, 'work')).toBe(true);
    expect(getDaemon(dir, 'work')).toBeNull();
  });

  it('liveness needs a live process AND a fresh heartbeat', () => {
    const r = rec();
    expect(isDaemonAlive(r, { now: 2000, isProcessAlive: () => true })).toBe(true);
    expect(isDaemonAlive(r, { now: 2000, isProcessAlive: () => false })).toBe(false);
    expect(isDaemonAlive(r, { now: 1000 + 61_000, isProcessAlive: () => true })).toBe(false);
    expect(isDaemonAlive(null)).toBe(false);
  });

  it('inbox queues and drains in order, tolerating plain-text lines', () => {
    enqueueInboxMessage(dir, 'work', 'first');
    enqueueInboxMessage(dir, 'work', 'second');
    expect(drainInbox(dir, 'work')).toEqual(['first', 'second']);
    expect(drainInbox(dir, 'work')).toEqual([]);
  });

  it('runDaemonLoop registers, runs injected turns, and unregisters on exit (no daemon left running)', async () => {
    const turns: string[] = [];
    let registered = false;
    let unregistered = false;
    enqueueInboxMessage(dir, 'work', 'do the thing');
    await runDaemonLoop({
      dir,
      record: { ...rec(), pid: process.pid },
      pollMs: 1,
      maxIterations: 2,
      log: () => undefined,
      runTurn: async (m) => {
        turns.push(m);
      },
      apiRegister: async () => {
        registered = true;
      },
      apiUnregister: async () => {
        unregistered = true;
      },
    });
    expect(turns).toEqual(['do the thing']);
    expect(registered).toBe(true);
    expect(unregistered).toBe(true);
    expect(existsSync(join(dir, 'daemons.json'))).toBe(true);
    expect(getDaemon(dir, 'work')).toBeNull(); // cleaned up — nothing left running
    expect(readFileSync(join(dir, 'daemon-inbox', 'work.jsonl'), 'utf8')).toBe('');
  });
});
