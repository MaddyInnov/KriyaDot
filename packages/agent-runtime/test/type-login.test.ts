// SPDX-License-Identifier: Apache-2.0
// Tests for the type_login tool (password-safe credential typing).
//
// Security invariants under test:
//   - the password NEVER appears in tool args, tool results, or errors
//   - site verification refuses on mismatch (fail closed)
//   - the tool is approval-gated via computerUsePolicyRules()

import { describe, expect, it } from 'vitest';
import { MockOSScreenLayer, computerUsePolicyRules } from '../src/tools/computer.js';
import {
  TYPE_LOGIN_TOOL_NAME,
  createTypeLoginTool,
  normalizeSite,
  registerTypeLoginTool,
  sitesMatch,
  type TypeLoginRecord,
} from '../src/tools/type-login.js';
import type { ToolContext } from '../src/types.js';

const PASSWORD = 's3cr3t-p@ssw0rd-xyz';
const USERNAME = 'octocat';

function login(): TypeLoginRecord {
  return { name: 'github-personal', site: 'github.com', username: USERNAME, password: PASSWORD };
}

const ctx: ToolContext = { sessionId: 's1', botId: 'helper' };

describe('type_login', () => {
  it('has the canonical tool name', () => {
    expect(TYPE_LOGIN_TOOL_NAME).toBe('type_login');
  });

  it('types username, Tab, password via the OS layer on site match', async () => {
    const os = new MockOSScreenLayer();
    const tool = createTypeLoginTool({ os, getLogin: () => login() });
    const result = (await tool.handler({ loginId: 'github-personal', expectedSite: 'https://github.com/login' }, ctx)) as Record<string, unknown>;
    expect(result.typed).toBe(true);
    expect(result.loginId).toBe('github-personal');
    expect(result.site).toBe('github.com');
    // Password must not be in the result.
    expect(JSON.stringify(result)).not.toContain(PASSWORD);

    const types = os.callsOf('type').map((c) => c['text']);
    expect(types).toEqual([USERNAME, PASSWORD]);
    expect(os.callsOf('key').map((c) => c['name'])).toEqual(['Tab']);
  });

  it('refuses when expectedSite does not match the login site', async () => {
    const os = new MockOSScreenLayer();
    const tool = createTypeLoginTool({ os, getLogin: () => login() });
    await expect(tool.handler({ loginId: 'github-personal', expectedSite: 'evil.com' }, ctx)).rejects.toThrow(
      /does not match login site/,
    );
    expect(os.calls).toHaveLength(0); // nothing typed
  });

  it('requires expectedSite when no active-window verifier is configured', async () => {
    const os = new MockOSScreenLayer();
    const tool = createTypeLoginTool({ os, getLogin: () => login() });
    await expect(tool.handler({ loginId: 'github-personal' }, ctx)).rejects.toThrow(/expectedSite.*required/);
    expect(os.calls).toHaveLength(0);
  });

  it('uses the injected verifier when present (match)', async () => {
    const os = new MockOSScreenLayer();
    const tool = createTypeLoginTool({
      os,
      getLogin: () => login(),
      verifySite: async (site) => ({ matched: site === 'github.com', observed: 'GitHub — Chrome' }),
    });
    // No expectedSite needed when a verifier is injected.
    const result = (await tool.handler({ loginId: 'github-personal' }, ctx)) as Record<string, unknown>;
    expect(result.typed).toBe(true);
  });

  it('uses the injected verifier when present (mismatch refuses)', async () => {
    const os = new MockOSScreenLayer();
    const tool = createTypeLoginTool({
      os,
      getLogin: () => login(),
      verifySite: async () => ({ matched: false, observed: 'Some other app' }),
    });
    await expect(tool.handler({ loginId: 'github-personal' }, ctx)).rejects.toThrow(
      /focused window does not match login site/,
    );
    expect(os.calls).toHaveLength(0);
  });

  it('verifier errors fail closed', async () => {
    const os = new MockOSScreenLayer();
    const tool = createTypeLoginTool({
      os,
      getLogin: () => login(),
      verifySite: async () => {
        throw new Error('no foreground window');
      },
    });
    await expect(tool.handler({ loginId: 'github-personal' }, ctx)).rejects.toThrow(/site verification failed/);
    expect(os.calls).toHaveLength(0);
  });

  it('unknown login ids are rejected without leaking', async () => {
    const os = new MockOSScreenLayer();
    const tool = createTypeLoginTool({ os, getLogin: () => undefined });
    await expect(
      tool.handler({ loginId: 'github-personal', expectedSite: 'github.com' }, ctx),
    ).rejects.toThrow(/unknown login/);
  });

  it('rejects malformed loginId input', async () => {
    const os = new MockOSScreenLayer();
    const tool = createTypeLoginTool({ os, getLogin: () => login() });
    await expect(tool.handler({ loginId: '../../etc/passwd' }, ctx)).rejects.toThrow();
    await expect(tool.handler({}, ctx)).rejects.toThrow();
  });

  it('errors never contain the password', async () => {
    const os = new MockOSScreenLayer();
    // Force a typing failure mid-sequence.
    const failingOs = new MockOSScreenLayer();
    failingOs.type = async () => {
      throw new Error('os layer exploded');
    };
    const tool = createTypeLoginTool({ os: failingOs, getLogin: () => login() });
    try {
      await tool.handler({ loginId: 'github-personal', expectedSite: 'github.com' }, ctx);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(String(err)).not.toContain(PASSWORD);
    }
  });

  it('is approval-gated by computerUsePolicyRules()', () => {
    const rules = computerUsePolicyRules();
    const match = rules.filter((r) => new RegExp(r.toolPattern).test(TYPE_LOGIN_TOOL_NAME));
    expect(match.length).toBeGreaterThan(0);
    expect(match.every((r) => r.effect === 'require-approval')).toBe(true);
  });

  it('registerTypeLoginTool registers and rejects collisions', () => {
    const registry = new Map();
    const os = new MockOSScreenLayer();
    registerTypeLoginTool(registry, { os, getLogin: () => login() });
    expect(registry.has('type_login')).toBe(true);
    expect(() => registerTypeLoginTool(registry, { os, getLogin: () => login() })).toThrow(/collision/);
  });
});

describe('site normalization', () => {
  it('normalizeSite strips scheme, www, path, port', () => {
    expect(normalizeSite('https://www.GitHub.com/login')).toBe('github.com');
    expect(normalizeSite('http://example.com:8080/x')).toBe('example.com');
    expect(normalizeSite('WhatsApp Desktop')).toBe('whatsapp desktop');
  });

  it('sitesMatch handles subdomains and app-name variants', () => {
    expect(sitesMatch('github.com', 'www.github.com')).toBe(true);
    expect(sitesMatch('mail.google.com', 'google.com')).toBe(true);
    expect(sitesMatch('whatsapp', 'WhatsApp Desktop')).toBe(true);
    expect(sitesMatch('github.com', 'evil.com')).toBe(false);
    expect(sitesMatch('', 'github.com')).toBe(false);
  });
});

describe('sitesMatch dot-boundary matching (H1 fix)', () => {
  it('rejects lookalike suffix domains: evilgithub.com does NOT match github.com', () => {
    expect(sitesMatch('evilgithub.com', 'github.com')).toBe(false);
    expect(sitesMatch('github.com.evil.com', 'github.com')).toBe(false);
    expect(sitesMatch('mygithub.com', 'github.com')).toBe(false);
  });

  it('accepts true subdomains: sub.github.com matches github.com', () => {
    expect(sitesMatch('sub.github.com', 'github.com')).toBe(true);
    expect(sitesMatch('a.b.github.com', 'github.com')).toBe(true);
  });

  it('accepts exact domains and is case-insensitive', () => {
    expect(sitesMatch('github.com', 'github.com')).toBe(true);
    expect(sitesMatch('GITHUB.COM', 'github.com')).toBe(true);
    expect(sitesMatch('https://Sub.GitHub.com/login', 'github.com')).toBe(true);
  });

  it('keeps app-name alias matching for non-domain values', () => {
    expect(sitesMatch('whatsapp', 'WhatsApp Desktop')).toBe(true);
    expect(sitesMatch('slack', 'Slack')).toBe(true);
  });

  it('refuses credential typing when the bot asserts a lookalike site', async () => {
    const os = new MockOSScreenLayer();
    const tool = createTypeLoginTool({ os, getLogin: () => login() });
    await expect(
      tool.handler({ loginId: 'github-personal', expectedSite: 'evilgithub.com' }, ctx),
    ).rejects.toThrow(/does not match login site/);
    expect(os.calls).toHaveLength(0); // nothing typed
  });
});
