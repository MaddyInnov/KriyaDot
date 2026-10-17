// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  GovernanceGateway,
  DEFAULT_POLICY,
  mcpServerAllowRule,
  redactSecrets,
  type EvalContext,
  type Policy,
} from '../src/index.js';

const CTX: EvalContext = {
  sessionId: 'sess-1',
  botId: 'bot-1',
  actor: 'test-user',
};

function makeGateway() {
  return new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
}

const gateways: GovernanceGateway[] = [];
function fresh(): GovernanceGateway {
  const gw = makeGateway();
  gateways.push(gw);
  return gw;
}

afterEach(() => {
  while (gateways.length > 0) {
    gateways.pop()?.close();
  }
});

describe('deny-by-default', () => {
  it('unknown tool falls through to the default effect (require-approval)', async () => {
    const gw = fresh();
    const res = await gw.evaluate('some_mystery_tool', { foo: 'bar' }, CTX);
    expect(res.effect).toBe('require-approval');
    expect(res.approvalId).toBeDefined();
    const rec = gw.getApproval(res.approvalId as string);
    expect(rec?.status).toBe('pending');
    expect(rec?.toolName).toBe('some_mystery_tool');
  });

  it('classifies unknown tools conservatively as write', () => {
    const gw = fresh();
    expect(gw.classify('totally_unknown_thing')).toBe('write');
  });
});

describe('policy evaluation', () => {
  it('read-only tools auto-allow', async () => {
    const gw = fresh();
    for (const tool of ['read_file', 'web_search', 'web_fetch']) {
      const res = await gw.evaluate(tool, { path: 'x' }, CTX);
      expect(res.effect).toBe('allow');
      expect(res.approvalId).toBeUndefined();
    }
    expect(gw.listApprovals('pending')).toHaveLength(0);
  });

  it('write_file requires approval', async () => {
    const gw = fresh();
    const res = await gw.evaluate('write_file', { path: 'notes.txt' }, CTX);
    expect(res.effect).toBe('require-approval');
    expect(res.approvalId).toBeDefined();
    const pending = gw.listApprovals('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe('write_file');
    expect(pending[0].sessionId).toBe('sess-1');
  });

  it('hard floor: catastrophic commands are denied unconditionally (never approvable)', async () => {
    const gw = fresh();
    const catastrophic = [
      'rm -rf /',
      'rm -rf / --no-preserve-root',
      'sudo mkfs -t ext4 /dev/sda1',
      'dd if=/dev/zero of=/dev/sda bs=1M',
      'shred -u /home/user/secret.txt',
      'parted /dev/sda rm 1',
      ':(){ :|:& };:',
    ];
    for (const command of catastrophic) {
      const res = await gw.evaluate('run_command', { command }, CTX);
      expect(res.effect).toBe('deny');
      // No approval record is minted: there is nothing to approve.
      expect(res.approvalId).toBeUndefined();
      expect(gw.listApprovals('pending')).toHaveLength(0);
    }
  });

  it('hard floor: catastrophic stays denied even when the caller claims an approval', async () => {
    const gw = fresh();
    const command = 'rm -rf /';
    // First evaluation: unconditional deny, no approval id.
    const res = await gw.evaluate('run_command', { command }, CTX);
    expect(res.effect).toBe('deny');
    expect(res.approvalId).toBeUndefined();
    // A rogue caller mints a standalone approval out-of-band and marks it
    // approved. Re-evaluation must STILL deny: catastrophic calls are never
    // executable, regardless of any claimed approval.
    const claimedId = gw.requestApproval('run_command', { command }, CTX, {
      provenance: 'human',
    });
    gw.decide(claimedId, 'approved', { decidedBy: 'rogue-ui', note: 'claimed approval' });
    expect(gw.getApproval(claimedId)?.status).toBe('approved');
    const again = await gw.evaluate('run_command', { command }, CTX);
    expect(again.effect).toBe('deny');
    expect(again.approvalId).toBeUndefined();
  });

  it('hard floor: destructive-but-recoverable commands still go through the approval path', async () => {
    const gw = fresh();
    // sudo / shutdown: destructive, but recoverable → human approval.
    for (const command of ['sudo apt update', 'shutdown -h now']) {
      const res = await gw.evaluate('run_command', { command }, CTX);
      expect(res.effect).toBe('require-approval');
      expect(res.approvalId).toBeDefined();
      const rec = gw.getApproval(res.approvalId!);
      expect(rec?.provenance).toBe('hard-floor-escalated');
      expect(rec?.status).toBe('pending');
    }
    // Deleting a specific project file: destructive, recoverable → approval.
    const del = await gw.evaluate('delete_file', { path: '/etc/passwd' }, CTX);
    expect(del.effect).toBe('require-approval');
    expect(del.approvalId).toBeDefined();
    // The approval path still works: a human approval resolves it.
    const pending = gw.awaitDecision(del.approvalId!);
    gw.decide(del.approvalId!, 'approved', { decidedBy: 'test-human' });
    await expect(pending).resolves.toBe('approved');
  });

  it('hard floor: catastrophic cannot be reached via allow-all policy', async () => {
    const gw = fresh();
    const allowAll = { defaultEffect: 'allow' as const, rules: [] };
    const res = await gw.evaluateWithPolicy('run_command', { command: 'rm -rf /' }, CTX, allowAll);
    expect(res.effect).toBe('deny');
  });

  it('hard floor: mkfs and fork bombs are denied unconditionally', async () => {
    const gw = fresh();
    const bad = [
      'sudo mkfs -t ext4 /dev/sda1',
      ':(){ :|:& };:',
    ];
    for (const command of bad) {
      const res = await gw.evaluate('run_command', { command }, CTX);
      expect(res.effect).toBe('deny');
      expect(res.approvalId).toBeUndefined();
    }
    // Note: the legacy denylist still unconditionally denies `x(){...}`
    // function definitions (conservative); catastrophic hard floors deny
    // instead of escalating to human approval.
    const denied = await gw.evaluate('run_command', { command: 'x(){ echo hi; }' }, CTX);
    expect(denied.effect).toBe('deny');
  });

  it('benign run_command only requires approval', async () => {
    const gw = fresh();
    const res = await gw.evaluate('run_command', { command: 'ls -la' }, CTX);
    expect(res.effect).toBe('require-approval');
    expect(res.approvalId).toBeDefined();
  });
});

describe('approval lifecycle', () => {
  it('approve path resolves awaitDecision("approved")', async () => {
    const gw = fresh();
    const { approvalId } = await gw.evaluate('write_file', { path: 'a.txt' }, CTX);
    const id = approvalId as string;
    const pending = gw.awaitDecision(id);
    const rec = gw.decide(id, 'approved', { decidedBy: 'human-1', note: 'looks fine' });
    await expect(pending).resolves.toBe('approved');
    expect(rec.status).toBe('approved');
    expect(rec.decidedBy).toBe('human-1');
    expect(rec.note).toBe('looks fine');
    expect(typeof rec.decidedAt).toBe('number');
  });

  it('deny path resolves awaitDecision("denied")', async () => {
    const gw = fresh();
    const { approvalId } = await gw.evaluate('write_file', { path: 'a.txt' }, CTX);
    const id = approvalId as string;
    const pending = gw.awaitDecision(id);
    gw.decide(id, 'denied', { decidedBy: 'human-1' });
    await expect(pending).resolves.toBe('denied');
    expect(gw.getApproval(id)?.status).toBe('denied');
  });

  it('decide throws when the approval is not pending', async () => {
    const gw = fresh();
    const { approvalId } = await gw.evaluate('write_file', { path: 'a.txt' }, CTX);
    const id = approvalId as string;
    gw.decide(id, 'approved');
    expect(() => gw.decide(id, 'denied')).toThrow(/not pending/);
    expect(() => gw.decide('no-such-id', 'approved')).toThrow(/not found/);
  });

  it('awaitDecision on an already-decided approval resolves immediately', async () => {
    const gw = fresh();
    const { approvalId } = await gw.evaluate('write_file', { path: 'a.txt' }, CTX);
    const id = approvalId as string;
    gw.decide(id, 'approved');
    await expect(gw.awaitDecision(id)).resolves.toBe('approved');
  });

  it('timeout marks the approval expired and resolves "denied"', async () => {
    const gw = fresh();
    const { approvalId } = await gw.evaluate('write_file', { path: 'a.txt' }, CTX);
    const id = approvalId as string;
    const result = await gw.awaitDecision(id, 50);
    expect(result).toBe('denied');
    const rec = gw.getApproval(id);
    expect(rec?.status).toBe('expired');
    // A late decide must fail: the approval is no longer pending.
    expect(() => gw.decide(id, 'approved')).toThrow(/not pending/);
  });
});

describe('secret redaction', () => {
  it('redacts secrets in approval arg snapshots', async () => {
    const gw = fresh();
    const { approvalId } = await gw.evaluate(
      'write_file',
      {
        path: 'a.txt',
        apiKey: 'sk-live-SECRET-123',
        headers: { Authorization: 'Bearer hunter2' },
        nested: { creds: { password: 'p@ssw0rd' } },
        safe: 'visible-value',
      },
      CTX,
    );
    const rec = gw.getApproval(approvalId as string);
    expect(rec?.args['apiKey']).toBe('[REDACTED]');
    const headers = rec?.args['headers'] as Record<string, unknown>;
    expect(headers['Authorization']).toBe('[REDACTED]');
    const nested = rec?.args['nested'] as Record<string, Record<string, unknown>>;
    expect(nested['creds']['password']).toBe('[REDACTED]');
    expect(rec?.args['safe']).toBe('visible-value');
  });

  it('audit entries contain no secrets', async () => {
    const gw = fresh();
    await gw.evaluate(
      'write_file',
      { apiKey: 'sk-live-SECRET-123', token: 'tok-abc' },
      CTX,
    );
    gw.audit('custom.action', {
      actor: 'test-user',
      detail: { apiKey: 'sk-live-SECRET-123', inner: { secret: 'shh' }, ok: 1 },
    });
    const entries = gw.listAudit(50);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      if (entry.detail) {
        expect(entry.detail).not.toContain('sk-live-SECRET-123');
        expect(entry.detail).not.toContain('tok-abc');
        expect(entry.detail).not.toContain('shh');
      }
    }
    const withRedaction = entries.filter((e) => e.detail?.includes('[REDACTED]'));
    expect(withRedaction.length).toBeGreaterThan(0);
  });

  it('redactSecrets does not mutate its input', () => {
    const input = { apiKey: 'k', list: [{ token: 't' }] };
    const out = redactSecrets(input);
    expect(input.apiKey).toBe('k');
    expect(out.apiKey).toBe('[REDACTED]');
  });
});

describe('hooks', () => {
  it('pre and post hooks fire with the tool call context', async () => {
    const gw = fresh();
    const calls: string[] = [];
    gw.addPreHook((toolName, args, ctx) => {
      calls.push(`pre:${toolName}:${ctx.actor}`);
      expect(args['path']).toBe('a.txt');
    });
    gw.addPostHook((toolName, args, result, ctx) => {
      calls.push(`post:${toolName}:${String(result)}:${ctx.sessionId}`);
      expect(args['path']).toBe('a.txt');
    });
    await gw.runPreHooks('write_file', { path: 'a.txt' }, CTX);
    await gw.runPostHooks('write_file', { path: 'a.txt' }, 'ok', CTX);
    expect(calls).toEqual(['pre:write_file:test-user', 'post:write_file:ok:sess-1']);
  });

  it('multiple hooks run in registration order', async () => {
    const gw = fresh();
    const order: number[] = [];
    gw.addPreHook(() => {
      order.push(1);
    });
    gw.addPreHook(async () => {
      order.push(2);
    });
    await gw.runPreHooks('read_file', {}, CTX);
    expect(order).toEqual([1, 2]);
  });
});

describe('audit log', () => {
  it('listAudit paginates newest-first', () => {
    const gw = fresh();
    gw.audit('a1', { actor: 'u' });
    gw.audit('a2', { actor: 'u' });
    gw.audit('a3', { actor: 'u' });
    const all = gw.listAudit(10);
    expect(all.map((e) => e.action)).toEqual(['a3', 'a2', 'a1']);
    const page = gw.listAudit(1, 1);
    expect(page.map((e) => e.action)).toEqual(['a2']);
  });
});

describe('audit log retention (M4)', () => {
  it('pruneAuditLog keeps the newest N rows', () => {
    vi.useFakeTimers();
    try {
      const gw = fresh();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      for (let i = 0; i < 10; i++) gw.audit(`a${i}`, { actor: 'u' });
      vi.setSystemTime(new Date('2026-04-11T00:00:00Z')); // 100 days later
      const { deleted } = gw.pruneAuditLog(3, 90 * 24 * 60 * 60 * 1000);
      expect(deleted).toBe(7);
      expect(gw.listAudit(10).map((e) => e.action)).toEqual(['a9', 'a8', 'a7']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pruneAuditLog keeps rows newer than the age cutoff even beyond maxRows', () => {
    const gw = fresh();
    for (let i = 0; i < 10; i++) gw.audit(`a${i}`, { actor: 'u' });
    // All rows are fresh: the 90-day rule keeps more than maxRows=3.
    const { deleted } = gw.pruneAuditLog(3, 90 * 24 * 60 * 60 * 1000);
    expect(deleted).toBe(0);
    expect(gw.listAudit(20)).toHaveLength(10);
  });

  it('prune runs automatically every K inserts', () => {
    const gw = new GovernanceGateway({
      dbPath: ':memory:',
      policy: DEFAULT_POLICY,
      auditRetention: {
        maxRows: 10_000,
        maxAgeMs: 90 * 24 * 60 * 60 * 1000,
        pruneEveryInserts: 20,
      },
    });
    gateways.push(gw);
    const spy = vi.spyOn(gw, 'pruneAuditLog');
    for (let i = 0; i < 25; i++) gw.audit(`a${i}`, { actor: 'u' });
    // Sweep fired exactly once (on the 20th insert) with the configured bounds.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(10_000, 90 * 24 * 60 * 60 * 1000);
    expect(gw.listAudit(50)).toHaveLength(25); // nothing pruned: all fresh
  });
});

describe('MCP trust boundary', () => {
  it('an MCP write-ish tool pauses for approval by default (no auto-allow)', async () => {
    const gw = fresh();
    const res = await gw.evaluate('mcp:github:create_issue', { title: 'x' }, CTX);
    expect(res.effect).toBe('require-approval');
    expect(res.approvalId).toBeDefined();
    expect(gw.getApproval(res.approvalId as string)?.status).toBe('pending');
  });

  it('legacy mcp:<tool> names also require approval', async () => {
    const gw = fresh();
    const res = await gw.evaluate('mcp:send_email', { to: 'a@b.c' }, CTX);
    expect(res.effect).toBe('require-approval');
  });

  it('classify() treats mcp: tools as network (dead mcp__ check fixed)', () => {
    const gw = fresh();
    expect(gw.classify('mcp:github:create_issue')).toBe('network');
    expect(gw.classify('mcp:fetch:fetch')).toBe('network');
  });

  it('per-server opt-in re-allows that server only', async () => {
    const policy: Policy = {
      defaultEffect: 'require-approval',
      rules: [mcpServerAllowRule('github'), ...DEFAULT_POLICY.rules],
    };
    const gw = new GovernanceGateway({ dbPath: ':memory:', policy });
    gateways.push(gw);

    const allowed = await gw.evaluate('mcp:github:create_issue', { title: 'x' }, CTX);
    expect(allowed.effect).toBe('allow');
    expect(allowed.approvalId).toBeUndefined();

    // A different server is NOT covered by the opt-in.
    const other = await gw.evaluate('mcp:gitlab:create_issue', { title: 'x' }, CTX);
    expect(other.effect).toBe('require-approval');

    // Prefix-safety: 'github' opt-in must not match 'githubx' or bare 'mcp:'.
    const prefixTrick = await gw.evaluate('mcp:githubx:create_issue', { title: 'x' }, CTX);
    expect(prefixTrick.effect).toBe('require-approval');

    // Unrelated rules still work alongside the opt-in.
    const read = await gw.evaluate('read_file', { path: 'x' }, CTX);
    expect(read.effect).toBe('allow');
  });

  it('mcpServerAllowRule escapes regex metacharacters in server names', () => {
    const rule = mcpServerAllowRule('my.server');
    expect(rule.toolPattern).toBe('^mcp:my\\.server:');
    expect(rule.effect).toBe('allow');
    expect(new RegExp(rule.toolPattern, 'i').test('mcp:my.server:tool')).toBe(true);
    expect(new RegExp(rule.toolPattern, 'i').test('mcp:myXserver:tool')).toBe(false);
  });

  it('nothing auto-allows an MCP tool without explicit configuration', async () => {
    const gw = fresh();
    for (const tool of ['mcp:a:b', 'mcp:read_only_tool', 'mcp:fetch:fetch']) {
      const res = await gw.evaluate(tool, {}, CTX);
      expect(res.effect).not.toBe('allow');
    }
  });
});
