// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { MockOSScreenLayer } from '../src/tools/computer.js';
import {
  OnePasswordUnavailableError,
  createOnePasswordLoginSource,
  parseOpItem,
} from '../src/tools/login-source.js';
import { createTypeLoginTool } from '../src/tools/type-login.js';

const SECRET = 'op-secret-password-xyz';
const opJson = JSON.stringify({
  title: 'GitHub', urls: [{ href: 'https://github.com/login' }],
  fields: [
    { label: 'username', value: 'asha' },
    { label: 'password', value: SECRET },
  ],
});

describe('1Password login source', () => {
  it('maps op item fields to a login record via the injectable runner', async () => {
    const seen: string[][] = [];
    const src = createOnePasswordLoginSource({ runner: async (args) => { seen.push(args); return { stdout: opJson, code: 0 }; } });
    const rec = await src.getLogin('github-personal');
    expect(rec).toEqual({ name: 'GitHub', site: 'https://github.com/login', username: 'asha', password: SECRET });
    expect(seen[0]).toEqual(['item', 'get', 'github-personal', '--format', 'json']);
    expect(parseOpItem(JSON.stringify({ fields: [{ label: 'username', value: 'x' }] }), 'n')).toBeUndefined();
  });

  it('fails clearly when op is absent, and never echoes runner output on failure', async () => {
    const missing = createOnePasswordLoginSource({ runner: async () => { throw new OnePasswordUnavailableError(); } });
    await expect(missing.getLogin('x')).rejects.toBeInstanceOf(OnePasswordUnavailableError);
    const failing = createOnePasswordLoginSource({ runner: async () => ({ stdout: `leak ${SECRET}`, code: 1 }) });
    await expect(failing.getLogin('x')).rejects.toThrow('onepassword-item-read-failed');
    try { await failing.getLogin('x'); } catch (err) { expect(String(err)).not.toContain(SECRET); }
  });

  it('type_login with source=onepassword types the password but never returns it', async () => {
    const os = new MockOSScreenLayer();
    const typed: string[] = [];
    const origType = os.type.bind(os);
    os.type = async (t: string) => { typed.push(t); return origType(t); };
    const src = createOnePasswordLoginSource({ runner: async () => ({ stdout: opJson, code: 0 }) });
    const tool = createTypeLoginTool({
      os,
      getLogin: () => undefined,
      loginSources: [src],
    });
    const result = await tool.handler(
      { loginId: 'github-personal', source: 'onepassword', expectedSite: 'github.com' },
      { botId: 'b', sessionId: 's' } as never,
    );
    expect(result).toEqual({ typed: true, loginId: 'github-personal', site: 'https://github.com/login' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(typed).toContain(SECRET); // the password reached only os.type()
    // Default source stays the built-in vault.
    await expect(tool.handler({ loginId: 'github-personal', expectedSite: 'github.com' }, { botId: 'b', sessionId: 's' } as never)).rejects.toThrow(/unknown login/);
  });
});
