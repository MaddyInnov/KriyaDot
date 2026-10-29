// SPDX-License-Identifier: Apache-2.0
// `mvp-server acp` subcommand: arg parsing + early exit paths. The ACP
// protocol itself is covered by agent-runtime's acp-server tests.

import { describe, expect, it } from 'vitest';
import { parseAcpArgs, runAcpCli } from '../src/cli.js';

describe('parseAcpArgs', () => {
  it('defaults to the helper bot', () => {
    expect(parseAcpArgs(['acp'])).toEqual({ botId: 'helper', help: false });
  });

  it('parses --bot and --help', () => {
    expect(parseAcpArgs(['acp', '--bot', 'coder'])).toEqual({ botId: 'coder', help: false });
    expect(parseAcpArgs(['acp', '--help']).help).toBe(true);
  });

  it('rejects unknown options', () => {
    expect(() => parseAcpArgs(['acp', '--nope'])).toThrow('unknown option');
  });
});

describe('runAcpCli early exits', () => {
  it('prints help and exits 0 without building a runtime', async () => {
    const code = await runAcpCli(['acp', '--help'], {
      buildRuntime: async () => {
        throw new Error('must not build a runtime for --help');
      },
    });
    expect(code).toBe(0);
  });

  it('exits 1 for an unknown bot', async () => {
    const code = await runAcpCli(['acp', '--bot', 'ghost'], {
      findBot: async () => undefined,
      buildRuntime: async () => {
        throw new Error('must not build a runtime for an unknown bot');
      },
    });
    expect(code).toBe(1);
  });

  it('exits 2 for bad args', async () => {
    expect(await runAcpCli(['acp', '--bogus'])).toBe(2);
  });
});
