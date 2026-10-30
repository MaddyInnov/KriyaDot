// SPDX-License-Identifier: Apache-2.0
// #181 runtime log-level control (packages/agent-runtime/src/log.ts).

import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, getLogLevel, isLogLevel, parseLogLevel, setLogLevel, shouldLog } from '../src/log.js';

afterEach(() => {
  setLogLevel('info');
});

describe('runtime logger', () => {
  it('parses levels case-insensitively and rejects unknowns', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel('nope')).toBeNull();
    expect(parseLogLevel(42)).toBeNull();
    expect(isLogLevel('warn')).toBe(true);
    expect(() => setLogLevel('chatty')).toThrow(/unknown log level/);
  });

  it('gates records by the current level, checked at call time', () => {
    const lines: string[] = [];
    const log = createLogger('test', (l) => lines.push(l));
    setLogLevel('warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', scope: 'test', msg: 'w' });
    // A runtime toggle takes effect without recreating the logger.
    setLogLevel('debug');
    log.debug('d2', { k: 1 });
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!)).toMatchObject({ level: 'debug', msg: 'd2', k: 1 });
    expect(getLogLevel()).toBe('debug');
    expect(shouldLog('error')).toBe(true);
  });

  it('silent suppresses everything', () => {
    const lines: string[] = [];
    const log = createLogger('test', (l) => lines.push(l));
    setLogLevel('silent');
    log.error('boom');
    expect(lines).toHaveLength(0);
    expect(shouldLog('error')).toBe(false);
  });
});
