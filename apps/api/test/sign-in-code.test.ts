// SPDX-License-Identifier: Apache-2.0
// W4b tests: enter_sign_in_code — extractor unit tests, tool flow with a
// mocked Composio Gmail search + mocked browser input, governance rule,
// and the secrecy contract (the code value must appear NOWHERE in tool
// results or audit entries — asserted by scanning serialized outputs).
// Zero network, zero paid API usage.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENTER_SIGN_IN_CODE_TOOL,
  createComposioSignInSearcher,
  createEnterSignInCodeTool,
  extractSignInCode,
  normalizeGmailFetchResult,
  registerSignInCodeTools,
  signInCodePolicyRules,
  type SignInMessageInput,
} from '../src/sign-in-code-tools.js';
import type { ComposioClient, ComposioConnectedAccount } from '../src/composio.js';
import { MockOSScreenLayer } from '@mvp/agent-runtime/dist/tools/computer.js';
import type { ToolContext } from '@mvp/agent-runtime';

const NOW = Date.parse('2026-10-29T10:00:00Z');
const CODE = '481516';

function gmailMsg(partial: Partial<SignInMessageInput>): SignInMessageInput {
  return {
    subject: 'Your GitHub verification code',
    body: `Your verification code is ${CODE}. It expires in 10 minutes.`,
    sender: 'noreply@github.com',
    receivedAtMs: NOW - 60_000,
    source: 'gmail',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

describe('extractSignInCode', () => {
  const opts = { site: 'github.com', nowMs: NOW };

  it('extracts a typical "Your verification code is NNNNNN" email', () => {
    const r = extractSignInCode([gmailMsg({})], opts);
    expect(r).toEqual({ status: 'found', code: CODE, messageIndex: 0 });
  });

  it('extracts the reverse format "NNNNNN is your code"', () => {
    const r = extractSignInCode(
      [gmailMsg({ subject: 'GitHub sign-in', body: `${CODE} is your GitHub sign-in code.` })],
      opts,
    );
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.code).toBe(CODE);
  });

  it('extracts grouped codes ("123 456") and 4- / 8-digit codes', () => {
    const grouped = extractSignInCode(
      [gmailMsg({ body: 'Your one-time code: 481 516 — do not share it.' })],
      opts,
    );
    expect(grouped.status).toBe('found');
    if (grouped.status === 'found') expect(grouped.code).toBe(CODE);

    const pin = extractSignInCode([gmailMsg({ body: 'Your PIN is 0420.' })], opts);
    expect(pin.status).toBe('found');
    if (pin.status === 'found') expect(pin.code).toBe('0420');

    const eight = extractSignInCode([gmailMsg({ body: 'Security code: 12345678' })], opts);
    expect(eight.status).toBe('found');
    if (eight.status === 'found') expect(eight.code).toBe('12345678');
  });

  it('matches by service label in the body when the sender differs', () => {
    const r = extractSignInCode(
      [gmailMsg({ sender: 'alerts@mailprovider.example', body: `GitHub: your login code is ${CODE}` })],
      opts,
    );
    expect(r.status).toBe('found');
  });

  it('ignores messages for a different service', () => {
    const r = extractSignInCode(
      [gmailMsg({ sender: 'noreply@bank.example', subject: 'Bank code', body: 'Your verification code is 999999.' })],
      opts,
    );
    expect(r).toEqual({ status: 'not-found' });
  });

  it('requires code context — an order number alone is not a code', () => {
    const r = extractSignInCode(
      [gmailMsg({ subject: 'Your GitHub Shop order', body: 'Order number 123456 confirmed. Total: 50 credits.' })],
      opts,
    );
    expect(r).toEqual({ status: 'not-found' });
  });

  it('does not leak dates into candidates', () => {
    const r = extractSignInCode(
      [gmailMsg({ body: `On 2026-10-29 at 09:41 your GitHub code is ${CODE}.` })],
      opts,
    );
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.code).toBe(CODE);
  });

  it('the same code repeated across messages is still unambiguous', () => {
    const r = extractSignInCode([gmailMsg({}), gmailMsg({ subject: 'GitHub code reminder' })], opts);
    expect(r.status).toBe('found');
  });

  it('multiple distinct codes are ambiguous — never a guess', () => {
    const one = extractSignInCode(
      [gmailMsg({ body: 'Your code is 111111. Or use fallback code 222222.' })],
      opts,
    );
    expect(one).toEqual({ status: 'ambiguous', candidateCount: 2 });
    const two = extractSignInCode(
      [gmailMsg({}), gmailMsg({ body: 'Your verification code is 654321.' })],
      opts,
    );
    expect(two).toEqual({ status: 'ambiguous', candidateCount: 2 });
  });

  it('stale codes are rejected; the freshness window is configurable', () => {
    const stale = gmailMsg({ receivedAtMs: NOW - 30 * 60_000 });
    expect(extractSignInCode([stale], opts)).toEqual({ status: 'stale', candidateCount: 1 });
    const widened = extractSignInCode([stale], { ...opts, freshnessMs: 60 * 60_000 });
    expect(widened.status).toBe('found');
  });

  it('a fresh code wins when a stale different code also exists', () => {
    const r = extractSignInCode(
      [gmailMsg({ receivedAtMs: NOW - 30 * 60_000, body: 'Your verification code is 999999.' }), gmailMsg({})],
      opts,
    );
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.code).toBe(CODE);
  });

  it('no matching message at all → not-found', () => {
    expect(extractSignInCode([], opts)).toEqual({ status: 'not-found' });
    expect(extractSignInCode([gmailMsg({ body: 'Hello, no digits here.' })], opts)).toEqual({
      status: 'not-found',
    });
  });
});

describe('normalizeGmailFetchResult', () => {
  it('normalizes the messages shape with timestamps and bodies', () => {
    const out = normalizeGmailFetchResult({
      messages: [
        {
          subject: 'Code',
          body: 'Your code is 123456',
          sender: 'noreply@github.com',
          messageTimestamp: '2026-10-29T09:59:00Z',
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      subject: 'Code',
      body: 'Your code is 123456',
      sender: 'noreply@github.com',
      receivedAtMs: Date.parse('2026-10-29T09:59:00Z'),
      source: 'gmail',
    });
  });

  it('tolerates arrays and empty/garbage results', () => {
    expect(normalizeGmailFetchResult([{ subject: 'x' }])).toHaveLength(1);
    expect(normalizeGmailFetchResult({})).toEqual([]);
    expect(normalizeGmailFetchResult(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Governance rule
// ---------------------------------------------------------------------------

describe('signInCodePolicyRules', () => {
  it('requires approval for enter_sign_in_code', () => {
    const rules = signInCodePolicyRules();
    const rule = rules.find((r) => new RegExp(r.toolPattern).test(ENTER_SIGN_IN_CODE_TOOL))!;
    expect(rule).toBeTruthy();
    expect(rule.effect).toBe('require-approval');
    expect(rule.id).toBeTruthy();
    expect(rule.reason).toBeTruthy();
    // The rule must not accidentally match other tools.
    expect(rules.some((r) => new RegExp(r.toolPattern).test('computer_type'))).toBe(false);
  });

  it('the real governance gateway gates the tool behind approval (card args carry site+source only)', async () => {
    const { GovernanceGateway, DEFAULT_POLICY } = await import('@mvp/governance');
    const policy = {
      ...DEFAULT_POLICY,
      rules: [...signInCodePolicyRules(), ...DEFAULT_POLICY.rules],
    } as Parameters<typeof GovernanceGateway>[0]['policy'];
    const gw = new GovernanceGateway({ dbPath: ':memory:', policy });
    // Args are what the approval card shows: site + where the code will be
    // read from — by construction no code value can be among them.
    const sim = await gw.simulate(ENTER_SIGN_IN_CODE_TOOL, { site: 'github.com', source: 'gmail' });
    expect(sim.effect).toBe('require-approval');
    expect(sim.wouldCreateApproval).toBe(true);
    expect(sim.matchedRuleId).toBe('enter-sign-in-code-approval');
    const decided = await gw.evaluate(
      ENTER_SIGN_IN_CODE_TOOL,
      { site: 'github.com', source: 'gmail' },
      { actor: 'bot-1', botId: 'bot-1', sessionId: 's1' } as Parameters<typeof gw.evaluate>[2],
    );
    expect(decided.effect).toBe('require-approval');
    expect(decided.approvalId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tool flow (mocked Composio + mocked browser input)
// ---------------------------------------------------------------------------

function makeMockComposio(fetchData: unknown) {
  const state = {
    accounts: [
      { id: 'ca_gmail1', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'ACTIVE' },
    ] as ComposioConnectedAccount[],
    executed: [] as Array<{ toolSlug: string; connectedAccountId: string; args: Record<string, unknown> }>,
  };
  const client: ComposioClient = {
    validateApiKey: async () => ({ ok: true }),
    listApps: async () => [],
    createAuthLink: async () => ({ redirectUrl: 'https://example/link' }),
    listConnectedAccounts: async () => state.accounts.map((a) => ({ ...a })),
    getConnectedAccount: async (_k, id) => state.accounts.find((a) => a.id === id) ?? null,
    deleteConnectedAccount: async () => {},
    revokeConnectedAccount: async () => {},
    listTools: async () => [],
    executeTool: async (_k, input) => {
      state.executed.push({ toolSlug: input.toolSlug, connectedAccountId: input.connectedAccountId, args: input.args });
      return { successful: true, data: fetchData };
    },
  };
  return { client, state };
}

const fetchDataWithCode = {
  messages: [
    {
      subject: 'Your GitHub verification code',
      body: `Your verification code is ${CODE}. It expires in 10 minutes.`,
      sender: 'noreply@github.com',
      messageTimestamp: new Date(NOW - 60_000).toISOString(),
    },
  ],
};

describe('enter_sign_in_code tool flow', () => {
  let dir: string;
  const audit = vi.fn();
  const CTX: ToolContext = { sessionId: 's1', botId: 'bot-1' };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'signin-code-'));
    audit.mockClear();
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ 'bot-1': { gmail: true } }));
  });

  function makeTool(overrides: Partial<Parameters<typeof createEnterSignInCodeTool>[0]> = {}) {
    const mock = makeMockComposio(fetchDataWithCode);
    const os = new MockOSScreenLayer();
    const tool = createEnterSignInCodeTool({
      dataDir: dir,
      getApiKey: () => 'test-key',
      client: mock.client,
      resolveOS: () => os,
      audit,
      now: () => NOW,
      ...overrides,
    });
    return { tool, mock, os };
  }

  it('searches Gmail via Composio, types the code, returns/audits NO code', async () => {
    const { tool, mock, os } = makeTool();
    const result = (await tool.handler({ site: 'github.com' }, CTX)) as Record<string, unknown>;
    expect(result).toMatchObject({ entered: true, outcome: 'entered', site: 'github.com', sources: ['gmail'] });
    // The code went exactly one place: the OS layer's type() (the browser field).
    expect(os.callsOf('type')).toEqual([{ text: CODE }]);
    expect(mock.state.executed).toHaveLength(1);
    expect(mock.state.executed[0]).toMatchObject({ toolSlug: 'GMAIL_FETCH_EMAILS', connectedAccountId: 'ca_gmail1' });
    // Secrecy: neither the result nor any audit entry contains the code.
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect(audit).toHaveBeenCalledWith(
      'sign_in_code.result',
      expect.objectContaining({ toolName: ENTER_SIGN_IN_CODE_TOOL, actor: 'bot-1' }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain(CODE);
    const detail = audit.mock.calls[0]![1].detail as Record<string, unknown>;
    expect(detail).toMatchObject({ site: 'github.com', outcome: 'entered', sources: ['gmail'] });
  });

  it('registers as a mutating tool and registration is collision-safe', () => {
    const registry = new Map();
    const deps = {
      registry,
      dataDir: dir,
      getApiKey: () => 'k',
      client: makeMockComposio(fetchDataWithCode).client,
    };
    registerSignInCodeTools(deps);
    expect(registry.has(ENTER_SIGN_IN_CODE_TOOL)).toBe(true);
    expect(registry.get(ENTER_SIGN_IN_CODE_TOOL)!.mutating).toBe(true);
    registerSignInCodeTools(deps); // second registration must not throw or replace
    expect(registry.get(ENTER_SIGN_IN_CODE_TOOL)!.mutating).toBe(true);
  });

  it('no Composio key → no-source failure, nothing typed', async () => {
    const { tool, os } = makeTool({ getApiKey: () => undefined });
    const result = (await tool.handler({ site: 'github.com' }, CTX)) as Record<string, unknown>;
    expect(result).toMatchObject({ entered: false, outcome: 'no-source' });
    expect(os.calls).toHaveLength(0);
  });

  it('Gmail not enabled for the bot → no-source failure, nothing typed', async () => {
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ 'bot-1': { gmail: false } }));
    const { tool, os } = makeTool();
    const result = (await tool.handler({ site: 'github.com' }, CTX)) as Record<string, unknown>;
    expect(result).toMatchObject({ entered: false, outcome: 'no-source' });
    expect(os.calls).toHaveLength(0);
  });

  it('ambiguous codes → failure, nothing typed, no candidate leaks', async () => {
    const mock = makeMockComposio({
      messages: [
        {
          subject: 'GitHub code',
          body: 'Your verification code is 111111.',
          sender: 'noreply@github.com',
          messageTimestamp: new Date(NOW - 60_000).toISOString(),
        },
        {
          subject: 'GitHub code',
          body: 'Your verification code is 222222.',
          sender: 'noreply@github.com',
          messageTimestamp: new Date(NOW - 30_000).toISOString(),
        },
      ],
    });
    const os = new MockOSScreenLayer();
    const tool = createEnterSignInCodeTool({
      dataDir: dir,
      getApiKey: () => 'test-key',
      client: mock.client,
      resolveOS: () => os,
      audit,
      now: () => NOW,
    });
    const result = (await tool.handler({ site: 'github.com' }, CTX)) as Record<string, unknown>;
    expect(result).toMatchObject({ entered: false, outcome: 'ambiguous' });
    expect(os.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('111111');
    expect(JSON.stringify(result)).not.toContain('222222');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('111111');
    expect(JSON.stringify(audit.mock.calls)).not.toContain('222222');
  });

  it('not-found and stale outcomes type nothing', async () => {
    const none = makeTool();
    const emptyMock = makeMockComposio({ messages: [] });
    const toolNone = createEnterSignInCodeTool({
      dataDir: dir,
      getApiKey: () => 'k',
      client: emptyMock.client,
      resolveOS: () => none.os,
      audit,
      now: () => NOW,
    });
    expect(await toolNone.handler({ site: 'github.com' }, CTX)).toMatchObject({ outcome: 'not-found' });

    const staleMock = makeMockComposio({
      messages: [
        {
          subject: 'GitHub code',
          body: `Your verification code is ${CODE}.`,
          sender: 'noreply@github.com',
          messageTimestamp: new Date(NOW - 45 * 60_000).toISOString(),
        },
      ],
    });
    const os = new MockOSScreenLayer();
    const toolStale = createEnterSignInCodeTool({
      dataDir: dir,
      getApiKey: () => 'k',
      client: staleMock.client,
      resolveOS: () => os,
      audit,
      now: () => NOW,
    });
    const staleResult = (await toolStale.handler({ site: 'github.com' }, CTX)) as Record<string, unknown>;
    expect(staleResult).toMatchObject({ entered: false, outcome: 'stale' });
    expect(os.calls).toHaveLength(0);
    expect(JSON.stringify(staleResult)).not.toContain(CODE);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(CODE);
  });

  it('injected searcher path also works (messaging-style source)', async () => {
    const os = new MockOSScreenLayer();
    const tool = createEnterSignInCodeTool({
      dataDir: dir,
      getApiKey: () => undefined, // searcher override bypasses Composio entirely
      searcher: async () => ({ messages: [gmailMsg({ source: 'messages' })], sourcesSearched: ['messages'] }),
      resolveOS: () => os,
      audit,
      now: () => NOW,
    });
    const result = (await tool.handler({ site: 'github.com' }, CTX)) as Record<string, unknown>;
    expect(result).toMatchObject({ entered: true, outcome: 'entered', sources: ['messages'] });
    expect(os.callsOf('type')).toEqual([{ text: CODE }]);
  });

  it('validates arguments before any search', async () => {
    const { tool, mock } = makeTool();
    await expect(tool.handler({}, CTX)).rejects.toThrow(/site/);
    await expect(tool.handler({ site: 'github.com', freshnessMinutes: 999 }, CTX)).rejects.toThrow(/freshnessMinutes/);
    expect(mock.state.executed).toHaveLength(0);
  });

  it('a typing failure reports type-failed without leaking the code', async () => {
    const failingOS = new MockOSScreenLayer();
    failingOS.type = async () => {
      throw new Error('browser gone');
    };
    const { tool } = makeTool({ resolveOS: () => failingOS });
    const result = (await tool.handler({ site: 'github.com' }, CTX)) as Record<string, unknown>;
    expect(result).toMatchObject({ entered: false, outcome: 'type-failed' });
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(CODE);
  });
});

describe('createComposioSignInSearcher', () => {
  it('returns no sources when Gmail is not enabled for the bot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signin-searcher-'));
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ 'bot-9': { gmail: true } }));
    const mock = makeMockComposio(fetchDataWithCode);
    const searcher = createComposioSignInSearcher({ dataDir: dir, getApiKey: () => 'k', client: mock.client });
    const out = await searcher({ botId: 'bot-1', userId: 'default-user', site: 'github.com', nowMs: NOW });
    expect(out).toEqual({ messages: [], sourcesSearched: [] });
    expect(mock.state.executed).toHaveLength(0);
  });
});
